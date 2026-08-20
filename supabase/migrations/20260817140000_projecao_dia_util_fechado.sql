-- =============================================================================
-- PREMISSA (Amanda, 2026-08-17): a PROJECAO trabalha sempre com UM DIA UTIL A
-- MENOS -- so DIA FECHADO entra no ritmo. O dia corrente nao conta como dia
-- transcorrido.
--
-- Por que: o dinheiro do dia nao esta todo dentro no dia. Boleto cai em D+1 e
-- parte dos cartoes tambem; no proprio dia entra basicamente PIX (e alguns
-- cartoes ja baixados). Dividir o acumulado do mes pelos dias transcorridos
-- INCLUINDO hoje divide por um dia incompleto -> taxa diaria menor -> projecao
-- subestimada. Mesma conta que a Amanda ja fazia na mao ("acumulado saiu em 4
-- dias de pagamento -> divide por 4, nao por 5").
--
-- O QUE MUDA: apenas o DENOMINADOR do ritmo (v_du_pass) em
-- projecao_calcular_filial e projecao_calcular_operador. Nada de valor
-- recuperado/honorario/meta/faixa/comissao muda; o acumulado do mes continua
-- exibindo tudo que ja entrou hoje.
--   v_du_pass  = dias uteis FECHADOS  (transcorridos - 1, minimo 0)
--   v_du_rest  = inalterado (de hoje ate o fim do mes, inclusive)
--   => a partir de agora fechados + restantes = total do mes (antes somavam
--      total + 1, porque hoje era contado dos dois lados).
-- Mes ja encerrado (v_hoje > v_fim) NAO sofre desconto: todos os dias fecharam.
-- Primeiro dia util do mes: fechados = 0 -> projecao cai no fallback (= o
-- realizado, sem extrapolar), que ja existia.
--
-- Efeito colateral esperado nas telas: o card "Ritmo (dias uteis)" passa a
-- mostrar dias FECHADOS / total, e a projecao de fechamento sobe um pouco.
--
-- NAO ALTERA: tv_snapshot_calcular (TV usa a mesma formula e fica para um passo
-- separado), projecao_dashboard (legado, nao usada pela tela).
--
-- Rollback: reaplicar 20260728120000 (filial) e 20260729122000 (operador).
-- =============================================================================

create or replace function public.projecao_calcular_filial(p_mes text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_hoje date := current_date;
  v_ini  date := to_date(p_mes || '-01', 'YYYY-MM-DD');
  v_prox date := (to_date(p_mes || '-01', 'YYYY-MM-DD') + interval '1 month')::date;
  v_fim  date := (to_date(p_mes || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date;
  v_emails_ranking text[] := ARRAY[
    'cobranca03@aelbra.com.br','cobranca05@aelbra.com.br','cobranca06@aelbra.com.br',
    'cobranca08@aelbra.com.br','cobranca10@aelbra.com.br','cobranca11@aelbra.com.br',
    'cobranca13@aelbra.com.br','cobranca12@aelbra.com.br','cobranca07@aelbra.com.br'];
  v_rec_hoje numeric; v_hon_hoje numeric; v_qtd_hoje int;
  v_acum_mes numeric; v_hon_mes numeric; v_direto_v numeric; v_direto_h numeric;
  v_ranking jsonb; v_hist jsonb; v_maior jsonb;
  v_meta_operacional numeric; v_meta_honorario numeric; v_meta jsonb;
  v_du_rest int; v_du_pass int; v_du_total int;
  v_proj_filial numeric; v_pct_proj_filial numeric;
begin
  with mes as materialized (
    select data_pagamento, valor_pago, valor_honorario, retroativo,
           lower(operador_email) as oe, operador_nome
    from public.pagamentos
    where data_pagamento >= v_ini and data_pagamento < v_prox
  ),
  scal as (
    select
      coalesce(sum(valor_pago)      filter (where data_pagamento = v_hoje and not retroativo),0) rec_hoje,
      coalesce(sum(valor_honorario) filter (where data_pagamento = v_hoje and not retroativo),0) hon_hoje,
      count(*)                      filter (where data_pagamento = v_hoje and not retroativo)     qtd_hoje,
      coalesce(sum(valor_pago),0)      acum_mes,
      coalesce(sum(valor_honorario),0) hon_mes,
      coalesce(sum(valor_pago)      filter (where not retroativo and (oe is null or not (oe = any(v_emails_ranking)))),0) direto_v,
      coalesce(sum(valor_honorario) filter (where not retroativo and (oe is null or not (oe = any(v_emails_ranking)))),0) direto_h
    from mes
  ),
  rk as (
    select jsonb_agg(t order by t.valor_honorario desc) j from (
      select oe as operador_email, max(operador_nome) as operador_nome,
             sum(valor_pago) as valor_recuperado, sum(valor_honorario) as valor_honorario
      from mes where not retroativo and oe = any(v_emails_ranking)
      group by oe
    ) t
  ),
  hist as (
    select jsonb_agg(t order by t.dia) j from (
      select data_pagamento as dia, sum(valor_pago) as valor_recuperado, sum(valor_honorario) as valor_honorario
      from mes group by data_pagamento
    ) t
  ),
  mx as (
    select jsonb_build_object('operador_email', oe, 'operador_nome', operador_nome,
             'valor', valor_pago, 'data_pagamento', data_pagamento) j
    from mes where not retroativo and oe = any(v_emails_ranking) and valor_pago > 0
    order by valor_pago desc, data_pagamento asc, oe asc limit 1
  )
  select scal.rec_hoje, scal.hon_hoje, scal.qtd_hoje, scal.acum_mes, scal.hon_mes,
         scal.direto_v, scal.direto_h,
         coalesce(rk.j,'[]'::jsonb), coalesce(hist.j,'[]'::jsonb), coalesce(mx.j,'null'::jsonb)
    into v_rec_hoje, v_hon_hoje, v_qtd_hoje, v_acum_mes, v_hon_mes,
         v_direto_v, v_direto_h, v_ranking, v_hist, v_maior
  from scal
  left join rk   on true
  left join hist on true
  left join mx   on true;

  -- meta (1 linha, índice unique em mes_referencia)
  select meta_operacional, meta_honorario,
         jsonb_build_object(
           'meta_operacional', meta_operacional, 'meta_unidades', meta_unidades, 'meta_honorario', meta_honorario,
           'm1_valor', m1_valor, 'm1_percentual', m1_percentual, 'm2_valor', m2_valor, 'm2_percentual', m2_percentual,
           'm3_valor', m3_valor, 'm3_percentual', m3_percentual, 'm4_valor', m4_valor, 'm4_percentual', m4_percentual,
           'atualizado_por', atualizado_por, 'atualizado_em', atualizado_em)
    into v_meta_operacional, v_meta_honorario, v_meta
  from public.metas_projecao where mes_referencia = p_mes;
  v_meta_operacional := coalesce(v_meta_operacional,0);
  v_meta_honorario := coalesce(v_meta_honorario,0);
  v_meta := coalesce(v_meta, jsonb_build_object(
    'meta_operacional',0,'meta_unidades',0,'meta_honorario',0,
    'm1_valor',0,'m1_percentual',0,'m2_valor',0,'m2_percentual',0,
    'm3_valor',0,'m3_percentual',0,'m4_valor',0,'m4_percentual',0,
    'atualizado_por',null,'atualizado_em',null));

  select count(*) into v_du_rest  from generate_series(v_hoje, v_fim, interval '1 day') d where extract(isodow from d) < 6;
  select count(*) into v_du_total from generate_series(v_ini,  v_fim, interval '1 day') d where extract(isodow from d) < 6;
  select count(*) into v_du_pass  from generate_series(v_ini,  least(v_hoje, v_fim), interval '1 day') d where extract(isodow from d) < 6;
  -- PREMISSA 2026-08-17: 1 DIA UTIL A MENOS -- so dia FECHADO entra no ritmo.
  -- Boleto (e parte dos cartoes) cai em D+1; no proprio dia entra basicamente
  -- PIX, entao o dia corrente esta incompleto e nao pode virar base de ritmo.
  -- Mes ja encerrado nao sofre desconto (todos os dias fecharam).
  if v_hoje <= v_fim then v_du_pass := greatest(v_du_pass - 1, 0); end if;

  v_proj_filial := case when v_du_pass > 0 then round((v_hon_mes / v_du_pass) * v_du_total, 2) else v_hon_mes end;
  v_pct_proj_filial := case when v_meta_honorario > 0 then round((v_proj_filial / v_meta_honorario) * 100, 2) else 0 end;

  -- Payload idêntico à saída de GESTÃO de projecao_dashboard(p_mes,null,null).
  return jsonb_build_object(
    'mes_referencia', p_mes,
    'recuperado_hoje', v_rec_hoje, 'honorario_hoje', v_hon_hoje,
    'acumulado_mes', v_acum_mes, 'honorario_mes', v_hon_mes,
    'recuperado_hoje_filial', v_rec_hoje, 'acumulado_mes_filial', v_acum_mes,
    'honorario_hoje_filial', v_hon_hoje, 'honorario_mes_filial', v_hon_mes,
    'qtd_pagamentos_hoje_filial', v_qtd_hoje,
    'meta_recuperacao', v_meta_operacional, 'meta_honorario', v_meta_honorario,
    'percentual_meta', case when v_meta_honorario > 0 then round((v_hon_mes / v_meta_honorario) * 100, 2) else 0 end,
    'percentual_meta_filial', case when v_meta_honorario > 0 then round((v_hon_mes / v_meta_honorario) * 100, 2) else 0 end,
    'valor_restante_meta', greatest(v_meta_honorario - v_hon_mes, 0),
    'dias_uteis_restantes', v_du_rest,
    'media_diaria_necessaria', case when v_du_rest > 0 then round(greatest(v_meta_honorario - v_hon_mes, 0) / v_du_rest, 2) else 0 end,
    'meta_honorario_individual', null,
    'percentual_meta_individual_realizado', null,
    'projecao_honorario_individual', null,
    'percentual_projecao_individual', null,
    'projecao_honorario_filial', v_proj_filial,
    'percentual_projecao_filial', v_pct_proj_filial,
    'dias_uteis_passados', v_du_pass, 'dias_uteis_total_mes', v_du_total,
    'comissao_estimada_individual', 0, 'faixa_atual', null,
    'recuperado_mes_amanda_adm', null, 'comissao_amanda_adm', null,
    'ranking_equipe', coalesce(v_ranking,'[]'::jsonb),
    'maior_pagamento_individual', coalesce(v_maior,'null'::jsonb),
    'direto_valor_recuperado', v_direto_v, 'direto_valor_honorario', v_direto_h,
    'historico_dia_a_dia', coalesce(v_hist,'[]'::jsonb),
    'e_gestao', true, 'config_metas', v_meta,
    'operador_selecionado_email', null,
    'recuperado_reativa_hoje', v_rec_hoje, 'recuperado_reativa_mes', v_acum_mes
  );
end;
$function$;

revoke all on function public.projecao_calcular_filial(text) from public, anon, authenticated;

create or replace function public.projecao_calcular_operador(p_mes text, p_email text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_hoje date := current_date;
  v_ini  date := to_date(p_mes || '-01', 'YYYY-MM-DD');
  v_prox date := (to_date(p_mes || '-01', 'YYYY-MM-DD') + interval '1 month')::date;
  v_fim  date := (to_date(p_mes || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date;
  v_sem boolean := (p_email = 'SEM_OPERADOR');
  v_amanda_adm boolean := (p_email = 'cobranca07@aelbra.com.br');
  v_equipe text[] := ARRAY[
    'cobranca03@aelbra.com.br','cobranca05@aelbra.com.br','cobranca06@aelbra.com.br',
    'cobranca08@aelbra.com.br','cobranca10@aelbra.com.br','cobranca11@aelbra.com.br',
    'cobranca13@aelbra.com.br','cobranca12@aelbra.com.br','cobranca07@aelbra.com.br'];
  v_tem_faixa boolean := (p_email = any(v_equipe)) and not v_amanda_adm;
  v_rec_hoje numeric; v_hon_hoje numeric; v_acum_mes numeric; v_hon_mes numeric; v_qtd_hoje int;
  v_nome text; v_hist jsonb;
  v_m1 numeric; v_m1p numeric; v_m2 numeric; v_m2p numeric; v_m3 numeric; v_m3p numeric; v_m4 numeric; v_m4p numeric;
  v_du_rest int; v_du_pass int; v_du_total int;
  v_meta_ind numeric; v_pct_meta_ind numeric; v_proj_ind numeric; v_pct_proj_ind numeric;
  v_pct_faixa numeric; v_faixa text; v_comissao numeric; v_rec_amanda numeric; v_com_amanda numeric;
  v_prox_faixa numeric; v_falta numeric;
begin
  with op as materialized (
    select data_pagamento, valor_pago, valor_honorario, retroativo, operador_nome
    from public.pagamentos
    where data_pagamento >= v_ini and data_pagamento < v_prox
      and ( (v_sem and operador_email is null)
            or (not v_sem and lower(operador_email) = p_email) )
  ),
  scal as (
    select
      coalesce(sum(valor_pago)      filter (where data_pagamento = v_hoje and not retroativo),0) rec_hoje,
      coalesce(sum(valor_honorario) filter (where data_pagamento = v_hoje and not retroativo),0) hon_hoje,
      count(*)                      filter (where data_pagamento = v_hoje and not retroativo)     qtd_hoje,
      coalesce(sum(valor_pago),0) acum_mes,
      coalesce(sum(valor_honorario),0) hon_mes,
      max(operador_nome) nome
    from op
  )
  select scal.rec_hoje, scal.hon_hoje, scal.qtd_hoje, scal.acum_mes, scal.hon_mes, scal.nome
    into v_rec_hoje, v_hon_hoje, v_qtd_hoje, v_acum_mes, v_hon_mes, v_nome
  from scal;

  select coalesce(m1_valor,0),coalesce(m1_percentual,0),coalesce(m2_valor,0),coalesce(m2_percentual,0),
         coalesce(m3_valor,0),coalesce(m3_percentual,0),coalesce(m4_valor,0),coalesce(m4_percentual,0)
    into v_m1,v_m1p,v_m2,v_m2p,v_m3,v_m3p,v_m4,v_m4p
  from public.metas_projecao where mes_referencia = p_mes;
  v_m1:=coalesce(v_m1,0); v_m1p:=coalesce(v_m1p,0); v_m2:=coalesce(v_m2,0); v_m2p:=coalesce(v_m2p,0);
  v_m3:=coalesce(v_m3,0); v_m3p:=coalesce(v_m3p,0); v_m4:=coalesce(v_m4,0); v_m4p:=coalesce(v_m4p,0);

  select count(*) into v_du_rest  from generate_series(v_hoje, v_fim, interval '1 day') d where extract(isodow from d) < 6;
  select count(*) into v_du_total from generate_series(v_ini,  v_fim, interval '1 day') d where extract(isodow from d) < 6;
  select count(*) into v_du_pass  from generate_series(v_ini,  least(v_hoje, v_fim), interval '1 day') d where extract(isodow from d) < 6;
  -- PREMISSA 2026-08-17: 1 DIA UTIL A MENOS -- so dia FECHADO entra no ritmo.
  -- Boleto (e parte dos cartoes) cai em D+1; no proprio dia entra basicamente
  -- PIX, entao o dia corrente esta incompleto e nao pode virar base de ritmo.
  -- Mes ja encerrado nao sofre desconto (todos os dias fecharam).
  if v_hoje <= v_fim then v_du_pass := greatest(v_du_pass - 1, 0); end if;

  -- EVOLUCAO DIARIA: acumulado + faixa/comissao vigente por dia (honorario acumulado).
  with op as (
    select data_pagamento, valor_pago, valor_honorario
    from public.pagamentos
    where data_pagamento >= v_ini and data_pagamento < v_prox
      and ( (v_sem and operador_email is null)
            or (not v_sem and lower(operador_email) = p_email) )
  ),
  dias as (
    select data_pagamento dia, sum(valor_pago) rec_dia, sum(valor_honorario) hon_dia, count(*) qtd_dia
    from op group by data_pagamento
  ),
  acc as (
    select dia, rec_dia, hon_dia, qtd_dia,
           sum(rec_dia) over (order by dia rows between unbounded preceding and current row) rec_acum,
           sum(hon_dia) over (order by dia rows between unbounded preceding and current row) hon_acum
    from dias
  )
  select jsonb_agg(jsonb_build_object(
    'dia', dia,
    -- chaves legadas (compat com grafico atual):
    'valor_recuperado', rec_dia, 'valor_honorario', hon_dia,
    -- enriquecido:
    'recuperado_dia', rec_dia, 'honorario_dia', hon_dia, 'qtd_pagamentos_dia', qtd_dia,
    'recuperado_acumulado', rec_acum, 'honorario_acumulado', hon_acum,
    'percentual_meta', case when v_m4>0 then round(hon_acum / v_m4 * 100, 2) else 0 end,
    'faixa', case
      when v_amanda_adm then 'ADM - 8% sobre honorarios'
      when not v_tem_faixa then 'Sem faixa'
      when v_m4>0 and hon_acum>=v_m4 then 'Faixa 4 ('||v_m4p||'%)'
      when v_m3>0 and hon_acum>=v_m3 then 'Faixa 3 ('||v_m3p||'%)'
      when v_m2>0 and hon_acum>=v_m2 then 'Faixa 2 ('||v_m2p||'%)'
      when v_m1>0 and hon_acum>=v_m1 then 'Faixa 1 ('||v_m1p||'%)'
      else 'Abaixo da faixa minima (0%)' end,
    'percentual_comissao', case
      when v_amanda_adm then 8
      when not v_tem_faixa then 0
      when v_m4>0 and hon_acum>=v_m4 then v_m4p
      when v_m3>0 and hon_acum>=v_m3 then v_m3p
      when v_m2>0 and hon_acum>=v_m2 then v_m2p
      when v_m1>0 and hon_acum>=v_m1 then v_m1p else 0 end,
    'comissao_estimada', case
      when v_amanda_adm then round(hon_acum*0.08,2)
      when not v_tem_faixa then 0
      else round(hon_acum * (case
        when v_m4>0 and hon_acum>=v_m4 then v_m4p when v_m3>0 and hon_acum>=v_m3 then v_m3p
        when v_m2>0 and hon_acum>=v_m2 then v_m2p when v_m1>0 and hon_acum>=v_m1 then v_m1p else 0 end)/100.0,2) end,
    'falta_proxima_faixa', case
      when not v_tem_faixa then null
      when v_m2>0 and hon_acum<v_m2 then round(v_m2-hon_acum,2)
      when v_m3>0 and hon_acum<v_m3 then round(v_m3-hon_acum,2)
      when v_m4>0 and hon_acum<v_m4 then round(v_m4-hon_acum,2)
      else 0 end
  ) order by dia)
  into v_hist from acc;
  v_hist := coalesce(v_hist, '[]'::jsonb);

  -- Resumo do mes (faixa/comissao final) + proxima faixa/quanto falta.
  if v_amanda_adm then
    v_rec_amanda := v_acum_mes; v_com_amanda := round(v_hon_mes * 0.08, 2);
    v_comissao := v_com_amanda; v_faixa := 'ADM - 8% sobre honorarios';
    v_prox_faixa := null; v_falta := null;
  elsif v_tem_faixa then
    v_meta_ind := v_m4;
    v_pct_meta_ind := case when v_meta_ind > 0 then round((v_hon_mes / v_meta_ind) * 100, 2) else 0 end;
    v_proj_ind := case when v_du_pass > 0 then round((v_hon_mes / v_du_pass) * v_du_total, 2) else v_hon_mes end;
    v_pct_proj_ind := case when v_meta_ind > 0 then round((v_proj_ind / v_meta_ind) * 100, 2) else 0 end;
    v_pct_faixa := case
      when v_m4 > 0 and v_hon_mes >= v_m4 then v_m4p when v_m3 > 0 and v_hon_mes >= v_m3 then v_m3p
      when v_m2 > 0 and v_hon_mes >= v_m2 then v_m2p when v_m1 > 0 and v_hon_mes >= v_m1 then v_m1p else 0 end;
    v_comissao := round(v_hon_mes * (v_pct_faixa / 100.0), 2);
    v_faixa := case
      when v_m4 > 0 and v_hon_mes >= v_m4 then 'Faixa 4 (' || v_m4p || '%)'
      when v_m3 > 0 and v_hon_mes >= v_m3 then 'Faixa 3 (' || v_m3p || '%)'
      when v_m2 > 0 and v_hon_mes >= v_m2 then 'Faixa 2 (' || v_m2p || '%)'
      when v_m1 > 0 and v_hon_mes >= v_m1 then 'Faixa 1 (' || v_m1p || '%)'
      else 'Abaixo da faixa minima (0%)' end;
    v_prox_faixa := case
      when v_m2>0 and v_hon_mes<v_m2 then v_m2 when v_m3>0 and v_hon_mes<v_m3 then v_m3
      when v_m4>0 and v_hon_mes<v_m4 then v_m4 else null end;
    v_falta := case when v_prox_faixa is null then 0 else round(v_prox_faixa - v_hon_mes, 2) end;
  else
    -- nao-equipe / SEM_OPERADOR: sem faixa/meta/comissao
    v_comissao := 0; v_faixa := 'Sem faixa'; v_prox_faixa := null; v_falta := null;
  end if;

  return jsonb_build_object(
    'mes_referencia', p_mes,
    'operador_email', case when v_sem then null else p_email end,
    'operador_nome', coalesce(v_nome, case when v_sem then 'Sem operador' else p_email end),
    'e_gestao', false,
    'recuperado_hoje', v_rec_hoje, 'honorario_hoje', v_hon_hoje, 'qtd_pagamentos_hoje', v_qtd_hoje,
    'acumulado_mes', v_acum_mes, 'honorario_mes', v_hon_mes,
    'meta_honorario_individual', v_meta_ind,
    'percentual_meta_individual_realizado', v_pct_meta_ind,
    'projecao_honorario_individual', v_proj_ind,
    'percentual_projecao_individual', v_pct_proj_ind,
    'comissao_estimada_individual', v_comissao, 'faixa_atual', v_faixa,
    'proxima_faixa_valor', v_prox_faixa, 'falta_proxima_faixa', v_falta,
    'recuperado_mes_amanda_adm', v_rec_amanda, 'comissao_amanda_adm', v_com_amanda,
    'dias_uteis_passados', v_du_pass, 'dias_uteis_total_mes', v_du_total, 'dias_uteis_restantes', v_du_rest,
    'historico_dia_a_dia', v_hist,
    'ranking_equipe', '[]'::jsonb, 'maior_pagamento_individual', 'null'::jsonb,
    'config_metas', jsonb_build_object('m1_valor',v_m1,'m1_percentual',v_m1p,'m2_valor',v_m2,'m2_percentual',v_m2p,
                                       'm3_valor',v_m3,'m3_percentual',v_m3p,'m4_valor',v_m4,'m4_percentual',v_m4p)
  );
end;
$function$;
revoke all on function public.projecao_calcular_operador(text,text) from public, anon, authenticated;

-- =============================================================================
-- Escopo dos 9 + evolucao diaria enriquecida + geracao do detalhe + leitura
-- paginada com validacao de escopo. NAO edita a 20260728163000 (esta redefine
-- por cima, mantendo PK/estrutura). Base da comissao = HONORARIO do mes.
--
-- Equipe (9): cobranca03/05/06/08/10/11/12/13 (operadores) + cobranca07 (Amanda ADM).
-- Fora do individual: Amanda (amanda.seibel), Fernanda (cobranca04), painel.tv,
-- e-mails antigos. SEM_OPERADOR gerado a parte, visivel so p/ gestao, sem
-- ranking/meta/comissao. Total da Empresa (payload FILIAL) segue somando TUDO.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Calculo individual com EVOLUCAO DIARIA (faixa/comissao por dia, acumulado).
--    A faixa de cada dia usa o HONORARIO ACUMULADO ate aquele dia (nao o total
--    do mes repetido). SEM_OPERADOR e nao-equipe recebem faixa/comissao neutras.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2) Atualizacao (um clique): FILIAL + 9 OPERADOR + 1 SEM_OPERADOR + detalhe.
--    Gera individual SOMENTE para a equipe dos 9 (+ SEM_OPERADOR). Nao gera
--    linha para Amanda, Fernanda, painel.tv ou e-mails antigos. Atomica: delete
--    + reinsert do mes; falha preserva o snapshot anterior. statement_timeout 30s.
-- ---------------------------------------------------------------------------
create or replace function public.projecao_snapshot_atualizar(p_mes text)
 returns jsonb language plpgsql security definer
 set search_path to 'public' set statement_timeout to '30s'
as $function$
declare
  v_email text := lower(auth.email());
  v_got boolean; v_t0 timestamptz; v_now timestamptz; v_ms int;
  v_filial jsonb; v_n_ops int := 0; rec record;
  v_equipe text[] := ARRAY[
    'cobranca03@aelbra.com.br','cobranca05@aelbra.com.br','cobranca06@aelbra.com.br',
    'cobranca08@aelbra.com.br','cobranca10@aelbra.com.br','cobranca11@aelbra.com.br',
    'cobranca13@aelbra.com.br','cobranca12@aelbra.com.br','cobranca07@aelbra.com.br'];
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and coalesce(v_email,'') not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br') then
    raise exception 'Acesso negado: apenas Amanda e Fernanda podem atualizar a projecao (usuario=%).',
      coalesce(v_email,'(anonimo)') using errcode = '42501';
  end if;
  v_got := pg_try_advisory_xact_lock(hashtext('projecao_snapshot_atualizar')::int, hashtext(p_mes)::int);
  if not v_got then
    raise exception 'Ja existe uma atualizacao em andamento para %.', p_mes using errcode = '55P03';
  end if;
  v_t0 := clock_timestamp(); v_now := now();
  begin
    if coalesce(current_setting('projecao.forcar_erro', true),'') = '1' then
      raise exception 'FALHA_SIMULADA_TESTE';
    end if;
    v_filial := public.projecao_calcular_filial(p_mes);

    delete from public.projecao_snapshot where mes_referencia = p_mes;
    insert into public.projecao_snapshot(escopo,mes_referencia,operador_email,payload,status,atualizado_em,atualizado_por,duracao_ms,erro_resumo)
      values ('FILIAL', p_mes, '', v_filial, 'ok', v_now, coalesce(v_email,'service_role'), null, null);

    -- individual APENAS para os 9 + SEM_OPERADOR (fixo, sem varrer usuarios).
    for rec in select unnest(v_equipe || array['SEM_OPERADOR']) as oe
    loop
      insert into public.projecao_snapshot(escopo,mes_referencia,operador_email,payload,status,atualizado_em,atualizado_por,duracao_ms,erro_resumo)
      values ('OPERADOR', p_mes, rec.oe, public.projecao_calcular_operador(p_mes, rec.oe), 'ok', v_now, coalesce(v_email,'service_role'), null, null);
      v_n_ops := v_n_ops + 1;
    end loop;

    -- DETALHE dos pagamentos (mesma execucao). So dos 9 + SEM_OPERADOR.
    delete from public.projecao_snapshot_pagamentos where mes_referencia = p_mes;
    insert into public.projecao_snapshot_pagamentos(
      mes_referencia, data_pagamento, operador_email, pagamento_id, aluno_nome,
      valor_pago, valor_honorario, importacao_id, operador_ajustado_manualmente, atualizado_em)
    select p_mes, p.data_pagamento,
           coalesce(lower(p.operador_email),'SEM_OPERADOR'),
           p.id, p.aluno_nome, p.valor_pago, p.valor_honorario, p.importacao_id,
           coalesce(p.operador_ajustado_manualmente,false), v_now
    from public.pagamentos p
    where p.data_pagamento >= to_date(p_mes||'-01','YYYY-MM-DD')
      and p.data_pagamento <  (to_date(p_mes||'-01','YYYY-MM-DD') + interval '1 month')::date
      and ( p.operador_email is null or lower(p.operador_email) = any(v_equipe) );
  exception when others then
    update public.projecao_snapshot
      set status='erro', erro_resumo=left(sqlerrm,300), atualizado_em=v_now, atualizado_por=coalesce(v_email,'service_role')
      where mes_referencia = p_mes and escopo='FILIAL';
    return jsonb_build_object('status','erro','mes_referencia',p_mes,'erro_resumo',left(sqlerrm,300));
  end;

  v_ms := round(extract(milliseconds from clock_timestamp() - v_t0));
  update public.projecao_snapshot set duracao_ms = v_ms where mes_referencia = p_mes;
  return jsonb_build_object('status','ok','mes_referencia',p_mes,'duracao_ms',v_ms,
    'operadores', v_n_ops, 'atualizado_em', v_now, 'atualizado_por', coalesce(v_email,'service_role'));
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3) Leitura: gestao -> filial + lista dos 9 + bloco SEM_OPERADOR (so gestao);
--    operador/Amanda ADM -> so o proprio. painel.tv/nao-equipe -> dados null.
-- ---------------------------------------------------------------------------
create or replace function public.projecao_snapshot_ler(p_mes text)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_email text := lower(auth.email());
  v_e_gestao boolean := v_email in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br');
  v_filial public.projecao_snapshot%rowtype;
  v_own public.projecao_snapshot%rowtype;
  v_ops jsonb; v_sem jsonb;
  v_equipe text[] := ARRAY[
    'cobranca03@aelbra.com.br','cobranca05@aelbra.com.br','cobranca06@aelbra.com.br',
    'cobranca08@aelbra.com.br','cobranca10@aelbra.com.br','cobranca11@aelbra.com.br',
    'cobranca13@aelbra.com.br','cobranca12@aelbra.com.br','cobranca07@aelbra.com.br'];
begin
  if coalesce(auth.role(),'') <> 'service_role' and public.perfil_do_usuario_atual() is null then
    raise exception 'Acesso negado: requer usuario autenticado e cadastro ativo.' using errcode = '42501';
  end if;

  select * into v_filial from public.projecao_snapshot where escopo='FILIAL' and mes_referencia=p_mes and operador_email='';
  if not found then
    return jsonb_build_object('status','vazio','mes_referencia',p_mes,'e_gestao',v_e_gestao,
      'dados',null,'operadores','[]'::jsonb,'sem_operador',null,
      'atualizado_em',null,'atualizado_por',null,'duracao_ms',null,'erro_resumo',null);
  end if;

  if v_e_gestao then
    -- ranking/"Por Operador": SOMENTE os 9 (exclui SEM_OPERADOR e nao-equipe)
    select coalesce(jsonb_agg(jsonb_build_object(
              'operador_email', operador_email,
              'operador_nome', payload->>'operador_nome',
              'honorario_mes', (payload->>'honorario_mes')::numeric,
              'faixa_atual', payload->>'faixa_atual',
              'comissao_estimada_individual', (payload->>'comissao_estimada_individual')::numeric,
              'projecao', (payload->>'projecao_honorario_individual')::numeric,
              'percentual_projecao', (payload->>'percentual_projecao_individual')::numeric
            ) order by (payload->>'honorario_mes')::numeric desc), '[]'::jsonb)
      into v_ops
    from public.projecao_snapshot
    where escopo='OPERADOR' and mes_referencia=p_mes and operador_email = any(v_equipe);

    -- SEM_OPERADOR: indicador separado, so gestao
    select payload into v_sem from public.projecao_snapshot
     where escopo='OPERADOR' and mes_referencia=p_mes and operador_email='SEM_OPERADOR';

    return jsonb_build_object(
      'status', v_filial.status, 'mes_referencia', p_mes,
      'atualizado_em', v_filial.atualizado_em, 'atualizado_por', v_filial.atualizado_por,
      'duracao_ms', v_filial.duracao_ms, 'erro_resumo', v_filial.erro_resumo,
      'e_gestao', true, 'dados', v_filial.payload, 'operadores', v_ops, 'sem_operador', v_sem);
  end if;

  -- nao-gestao: SOMENTE os proprios numeros (so se for um dos 9)
  select * into v_own from public.projecao_snapshot
   where escopo='OPERADOR' and mes_referencia=p_mes and operador_email = v_email and operador_email = any(v_equipe);

  return jsonb_build_object(
    'status', v_filial.status, 'mes_referencia', p_mes,
    'atualizado_em', v_filial.atualizado_em, 'atualizado_por', v_filial.atualizado_por,
    'duracao_ms', v_filial.duracao_ms, 'erro_resumo', v_filial.erro_resumo,
    'e_gestao', false,
    'dados', case when found then v_own.payload else null end,
    'operadores', '[]'::jsonb, 'sem_operador', null);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4) Leitura PAGINADA do detalhe do dia, com validacao de escopo no banco.
--    operador/Amanda ADM: forca o proprio email (ignora parametro).
--    gestao: qualquer um dos 9 ou 'SEM_OPERADOR'. painel.tv/outros: negado.
-- ---------------------------------------------------------------------------
create or replace function public.projecao_snapshot_pagamentos_ler(
  p_mes text, p_dia date, p_operador_email text, p_limit int default 50, p_offset int default 0)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_email text := lower(auth.email());
  v_e_gestao boolean := v_email in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br');
  v_equipe text[] := ARRAY[
    'cobranca03@aelbra.com.br','cobranca05@aelbra.com.br','cobranca06@aelbra.com.br',
    'cobranca08@aelbra.com.br','cobranca10@aelbra.com.br','cobranca11@aelbra.com.br',
    'cobranca13@aelbra.com.br','cobranca12@aelbra.com.br','cobranca07@aelbra.com.br'];
  v_alvo text;
  v_lim int := least(greatest(coalesce(p_limit,50),1),200);
  v_off int := greatest(coalesce(p_offset,0),0);
  v_total int; v_itens jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' and public.perfil_do_usuario_atual() is null then
    raise exception 'Acesso negado: requer usuario autenticado e cadastro ativo.' using errcode = '42501';
  end if;

  if v_e_gestao then
    -- gestao escolhe: um dos 9 ou SEM_OPERADOR
    v_alvo := lower(coalesce(p_operador_email,''));
    if v_alvo = 'sem_operador' then v_alvo := 'SEM_OPERADOR'; end if;
    if not (v_alvo = any(v_equipe) or v_alvo = 'SEM_OPERADOR') then
      raise exception 'Operador invalido para detalhe.' using errcode = '22023';
    end if;
  else
    -- nao-gestao: SEMPRE o proprio email (ignora o parametro), e so se for da equipe
    if not (v_email = any(v_equipe)) then
      raise exception 'Sem acesso ao detalhe de pagamentos.' using errcode = '42501';
    end if;
    v_alvo := v_email;
  end if;

  select count(*) into v_total from public.projecao_snapshot_pagamentos
   where mes_referencia=p_mes and operador_email=v_alvo and (p_dia is null or data_pagamento=p_dia);

  select coalesce(jsonb_agg(t order by t.data_pagamento, t.pagamento_id), '[]'::jsonb) into v_itens
  from (
    select pagamento_id, data_pagamento, aluno_nome, valor_pago, valor_honorario,
           importacao_id, operador_email, operador_ajustado_manualmente
    from public.projecao_snapshot_pagamentos
    where mes_referencia=p_mes and operador_email=v_alvo and (p_dia is null or data_pagamento=p_dia)
    order by data_pagamento, pagamento_id
    limit v_lim offset v_off
  ) t;

  return jsonb_build_object(
    'mes_referencia', p_mes, 'operador_email', v_alvo, 'data_pagamento', p_dia,
    'total', v_total, 'limit', v_lim, 'offset', v_off, 'itens', v_itens);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5) Seguranca: SECURITY DEFINER + search_path fixo; sem EXECUTE para public/anon.
-- ---------------------------------------------------------------------------
revoke all on function public.projecao_snapshot_ler(text)                             from public, anon;
revoke all on function public.projecao_snapshot_atualizar(text)                       from public, anon;
revoke all on function public.projecao_snapshot_pagamentos_ler(text,date,text,int,int) from public, anon;
grant execute on function public.projecao_snapshot_ler(text)                             to authenticated, service_role;
grant execute on function public.projecao_snapshot_atualizar(text)                       to authenticated, service_role;
grant execute on function public.projecao_snapshot_pagamentos_ler(text,date,text,int,int) to authenticated, service_role;

-- =============================================================================
-- TV ReATIVA — meta da empresa dinâmica (honorários) + contador na tela do mês
-- -----------------------------------------------------------------------------
-- Contexto: a "Meta da empresa" da TV estava CHUMBADA em R$ 450.000 (v_meta_emp),
-- enquanto a meta real da competência já vinha de metas_projecao.meta_honorario
-- (agosto/2026 = R$ 327.094). Isso deixava dois números conflitantes na mesma TV.
--
-- Esta migration é fiel à função de produção (pg_get_functiondef 2026-08-11),
-- idêntica exceto por 3 acréscimos cirúrgicos, todos em HONORÁRIOS:
--   A) v_meta_emp passa a ser coalesce(meta_honorario da competência, 450000).
--      Como v_meta já lê metas_projecao.meta_honorario, apenas reaproveitamos.
--   B) v_mes_obj ganha proj_honorarios + meta_pct + meta_falta + proj_honorarios_pct
--      para alimentar o termômetro da meta na tela "Resultado do Mês".
--   C) a tela "Metas" (linha 'empresa') usa v_meta_emp no lugar do 450000 fixo.
-- Nenhuma outra linha muda. Magic Number (500k) e Marco (3mi) permanecem como
-- metas de superação, propositalmente acima da meta base.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.tv_snapshot_calcular()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dados jsonb; v_proj jsonb; v_rank jsonb;
  v_dicas jsonb; v_elogios jsonb; v_aniv jsonb; v_aniv_hoje jsonb; v_msg jsonb;
  v_hoje_obj jsonb; v_mes_obj jsonb; v_metas jsonb; v_rankings jsonb; v_julho jsonb; v_avisos jsonb;
  v_premiacao jsonb;
  v_rec bigint; v_hon bigint; v_hon_total bigint; v_taxa_dia numeric;
  v_du_mes int; v_du_ate int; v_du_rest int;
  v_proj_rec bigint; v_proj_hon bigint; v_meta bigint; v_falta bigint; v_por_dia bigint; v_pct numeric;
  v_ant_rec bigint; v_ant_hon bigint; v_falta_3mi numeric; v_data_3mi date;
  v_pag_dia int; v_maior_dia jsonb; v_top_rec_dia jsonb; v_top_qtd_dia jsonb; v_sem_pag_dia boolean;
  v_pag_mes int; v_media_dia numeric; v_proj_fech numeric; v_nec_dia numeric; v_meta_emp bigint := 450000;
  v_hist_ativo boolean := false; v_hist_cfg jsonb;
  v_ops text[] := array['cobranca03@aelbra.com.br','cobranca05@aelbra.com.br','cobranca06@aelbra.com.br',
                        'cobranca08@aelbra.com.br','cobranca10@aelbra.com.br','cobranca11@aelbra.com.br',
                        'cobranca12@aelbra.com.br','cobranca13@aelbra.com.br'];
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_mes  text := to_char(v_hoje,'YYYY-MM');
  v_tem_rec boolean := to_regclass('public.recuperacao_historica') is not null;
  v_tem_elogio boolean := exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='aluno_movimentacoes' and column_name='elogio_aprovado_tv');
begin
  with unif as (
    select p.data_pagamento, p.valor_pago, p.valor_honorario,
           upper(btrim(coalesce(nullif(p.operador_nome,''), p.operador_email, 'Sem operador'))) as op_norm,
           p.operador_nome, p.operador_email,
           coalesce(nullif(p.cpf,''), p.aluno_nome) as aluno_ref
    from public.pagamentos p where p.data_pagamento is not null)
  select jsonb_build_object(
    'alunos_pagos_dia', (select count(distinct aluno_ref) from unif where data_pagamento = current_date),
    'alunos_pagos_mes', (select count(distinct aluno_ref) from unif where date_trunc('month',data_pagamento)=date_trunc('month',current_date)),
    'recuperado_dia', (select coalesce(round(sum(valor_pago)),0)::bigint from unif where data_pagamento = current_date),
    'honorarios_dia', (select coalesce(round(sum(valor_honorario)),0)::bigint from unif where data_pagamento = current_date),
    'ranking_semana', (select coalesce(jsonb_agg(jsonb_build_object('operador', op, 'pagos', pg) order by pg desc), '[]'::jsonb)
      from (select op_norm op, count(distinct aluno_ref) pg from unif where data_pagamento >= current_date - 6 and lower(operador_email) = any(v_ops) group by op_norm order by pg desc limit 8) r),
    'ranking_mes', (select coalesce(jsonb_agg(jsonb_build_object('operador', op, 'pagos', pg) order by pg desc), '[]'::jsonb)
      from (select op_norm op, count(distinct aluno_ref) pg from unif where date_trunc('month',data_pagamento)=date_trunc('month',current_date) and lower(operador_email) = any(v_ops) group by op_norm order by pg desc limit 8) r),
    'maior_pagamento', (select jsonb_build_object('aluno','','valor',round(valor_pago)::bigint,
        'operador',coalesce(nullif(operador_nome,''), operador_email,'-'),'quando',to_char(data_pagamento,'DD/MM'))
      from unif where date_trunc('month',data_pagamento)=date_trunc('month',current_date) and lower(operador_email) = any(v_ops) order by valor_pago desc nulls last limit 1)
  ) into v_dados;

  select coalesce(round(sum(valor_pago)),0)::bigint, coalesce(round(sum(valor_honorario)),0)::bigint
    into v_rec, v_hon
  from public.pagamentos where data_pagamento is not null
    and date_trunc('month',data_pagamento)=date_trunc('month',current_date);

  if v_tem_rec then
    select coalesce(round(sum(hon)),0)::bigint into v_hon_total from (
      select valor_honorario hon from public.pagamentos where data_pagamento is not null
      union all select valor_honorario from public.recuperacao_historica where data_pagamento is not null) x;
    select coalesce(sum(hon),0)/90.0 into v_taxa_dia from (
      select valor_honorario hon from public.pagamentos where data_pagamento > current_date - 90
      union all select valor_honorario from public.recuperacao_historica where data_pagamento > current_date - 90) y;
  else
    select coalesce(round(sum(valor_honorario)),0)::bigint into v_hon_total from public.pagamentos where data_pagamento is not null;
    select coalesce(sum(valor_honorario),0)/90.0 into v_taxa_dia from public.pagamentos where data_pagamento > current_date - 90;
  end if;

  v_falta_3mi := greatest(0, 3000000 - v_hon_total);
  v_data_3mi := case when v_taxa_dia > 0 and v_falta_3mi > 0 then current_date + ceil(v_falta_3mi / v_taxa_dia)::int else null end;

  select count(*) filter (where extract(dow from d) not in (0,6)),
         count(*) filter (where extract(dow from d) not in (0,6) and d <= current_date)
    into v_du_mes, v_du_ate
  from generate_series(date_trunc('month',current_date), (date_trunc('month',current_date) + interval '1 month - 1 day'), interval '1 day') d;

  v_du_ate := greatest(1, v_du_ate);
  v_du_rest := greatest(0, v_du_mes - v_du_ate);
  v_proj_rec := round(v_rec::numeric / v_du_ate * v_du_mes);
  v_proj_hon := round(v_hon::numeric / v_du_ate * v_du_mes);

  select meta_honorario::bigint into v_meta from public.metas_projecao where mes_referencia = to_char(current_date,'YYYY-MM') limit 1;
  v_pct := case when coalesce(v_meta,0) > 0 then round(v_hon::numeric / v_meta * 100, 1) else null end;
  v_falta := case when v_meta is not null then greatest(0, v_meta - v_hon) else null end;
  v_por_dia := case when v_falta is not null and v_du_rest > 0 then round(v_falta::numeric / v_du_rest) else null end;

  -- (A) Meta da empresa = meta de HONORÁRIOS da competência (fallback histórico 450k).
  v_meta_emp := coalesce(v_meta, 450000);

  select proj_recuperado, proj_honorarios into v_ant_rec, v_ant_hon
  from public.tv_projecao_snapshot where dia < current_date order by dia desc limit 1;

  insert into public.tv_projecao_snapshot (dia, recuperado_mes, honorarios_mes, proj_recuperado, proj_honorarios, atualizado_em)
  values (current_date, v_rec, v_hon, v_proj_rec, v_proj_hon, now())
  on conflict (dia) do update set recuperado_mes=excluded.recuperado_mes, honorarios_mes=excluded.honorarios_mes,
    proj_recuperado=excluded.proj_recuperado, proj_honorarios=excluded.proj_honorarios, atualizado_em=now();

  v_proj := jsonb_build_object(
    'recuperado_mes', v_rec, 'honorarios_mes', v_hon, 'honorarios_total', v_hon_total,
    'data_projecao_3mi', to_char(v_data_3mi, 'DD/MM/YYYY'),
    'proj_recuperado', v_proj_rec, 'proj_honorarios', v_proj_hon,
    'meta', v_meta, 'pct_meta', v_pct, 'falta', v_falta, 'precisa_por_dia', v_por_dia,
    'dias_restantes', v_du_rest, 'dias_uteis_mes', v_du_mes,
    'delta_proj_recuperado', case when v_ant_rec is null then null else v_proj_rec - v_ant_rec end,
    'delta_proj_honorarios', case when v_ant_hon is null then null else v_proj_hon - v_ant_hon end);

  v_rank := jsonb_build_object(
    'top_dia', coalesce((select jsonb_agg(t) from (
        select coalesce(max(u.apelido), max(u.nome), max(m.registrado_por_email)) as nome, count(*) as qtd
        from public.aluno_movimentacoes m left join public.usuarios u on lower(u.email) = lower(m.registrado_por_email)
        where public.eh_tipo_acionamento(m.tipo) and lower(m.registrado_por_email) = any(v_ops)
          and (m.registrado_em at time zone 'America/Sao_Paulo')::date = v_hoje
        group by lower(m.registrado_por_email) order by qtd desc limit 3) t),'[]'::jsonb),
    'top_mes', coalesce((select jsonb_agg(t) from (
        select coalesce(max(u.apelido), max(u.nome), max(m.registrado_por_email)) as nome, count(*) as qtd
        from public.aluno_movimentacoes m left join public.usuarios u on lower(u.email) = lower(m.registrado_por_email)
        where public.eh_tipo_acionamento(m.tipo) and lower(m.registrado_por_email) = any(v_ops)
          and to_char(m.registrado_em at time zone 'America/Sao_Paulo','YYYY-MM') = v_mes
        group by lower(m.registrado_por_email) order by qtd desc limit 3) t),'[]'::jsonb),
    'top_hon_dia', coalesce((select jsonb_agg(t) from (
        select coalesce(max(u.apelido), max(u.nome), max(p.operador_nome), max(p.operador_email)) as nome, sum(p.valor_honorario) as valor
        from public.pagamentos p left join public.usuarios u on lower(u.email) = lower(p.operador_email)
        where lower(p.operador_email) = any(v_ops) and p.data_pagamento = v_hoje
        group by lower(p.operador_email) having sum(p.valor_honorario) > 0 order by valor desc limit 3) t),'[]'::jsonb));

  select coalesce(jsonb_agg(jsonb_build_object('id',id,'categoria',categoria,'titulo',titulo,'texto',texto,'ordem',ordem) order by ordem), '[]'::jsonb)
    into v_dicas from public.tv_dicas where ativo = true;

  if v_tem_elogio then
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'registrado_por_nome',registrado_por_nome,
              'registrado_em',registrado_em,'elogio_print_path',elogio_print_path) order by registrado_em desc), '[]'::jsonb)
      into v_elogios
    from (select id, registrado_por_nome, registrado_em, elogio_print_path from public.aluno_movimentacoes
      where status_novo = 'ELOGIO_ATENDIMENTO' and elogio_aprovado_tv = true order by registrado_em desc limit 20) e;
  else v_elogios := '[]'::jsonb; end if;

  select coalesce(jsonb_agg(jsonb_build_object('nome', nome, 'dia', dia) order by dia nulls last, nome), '[]'::jsonb)
    into v_aniv from public.tv_aniversariantes
  where ativo = true and mes = extract(month from v_hoje);

  select coalesce(jsonb_agg(jsonb_build_object('nome', nome, 'dia', dia) order by nome), '[]'::jsonb)
    into v_aniv_hoje from public.tv_aniversariantes
  where ativo = true and mes = extract(month from v_hoje) and dia = extract(day from v_hoje);

  select jsonb_build_object('titulo', titulo, 'texto', texto) into v_msg
  from public.tv_mensagem_especial where ativo = true order by atualizado_em desc limit 1;

  select count(*)::int into v_pag_dia from public.pagamentos where data_pagamento = current_date;
  v_sem_pag_dia := (v_pag_dia = 0);
  select jsonb_build_object('valor', round(valor_pago)::bigint,
           'operador', coalesce(nullif(operador_nome,''), operador_email, '-'))
    into v_maior_dia from public.pagamentos where data_pagamento = current_date and lower(operador_email) = any(v_ops) order by valor_pago desc nulls last limit 1;
  select jsonb_build_object('operador', op, 'valor', vl) into v_top_rec_dia from (
    select upper(btrim(coalesce(nullif(operador_nome,''), operador_email))) op, round(sum(valor_pago))::bigint vl
    from public.pagamentos where data_pagamento = current_date and lower(operador_email) = any(v_ops)
    group by 1 order by vl desc limit 1) a;
  select jsonb_build_object('operador', op, 'qtd', q) into v_top_qtd_dia from (
    select upper(btrim(coalesce(nullif(operador_nome,''), operador_email))) op, count(*) q
    from public.pagamentos where data_pagamento = current_date and lower(operador_email) = any(v_ops)
    group by 1 order by q desc, op asc limit 1) a;
  v_hoje_obj := jsonb_build_object(
    'recuperado', (v_dados->>'recuperado_dia')::bigint, 'honorarios', (v_dados->>'honorarios_dia')::bigint,
    'pagamentos_confirmados', v_pag_dia, 'maior_pagamento', v_maior_dia,
    'top_recuperador', v_top_rec_dia, 'top_qtd', v_top_qtd_dia, 'sem_pagamentos', v_sem_pag_dia);

  select count(*)::int into v_pag_mes from public.pagamentos
   where date_trunc('month',data_pagamento)=date_trunc('month',current_date);
  v_media_dia := round(v_rec::numeric / v_du_ate);
  v_proj_fech := round(v_media_dia * v_du_mes);
  v_nec_dia := case when v_hon >= v_meta_emp then null when v_du_rest = 0 then null
                    else round((v_meta_emp - v_hon)::numeric / v_du_rest) end;
  -- (B) Termômetro da meta em HONORÁRIOS: acumulado, projeção e % contra a meta.
  v_mes_obj := jsonb_build_object(
    'recuperado', v_rec, 'honorarios', v_hon, 'pagamentos_confirmados', v_pag_mes,
    'media_diaria', v_media_dia, 'projecao_fechamento', v_proj_fech,
    'dias_uteis_mes', v_du_mes, 'dias_uteis_transcorridos', v_du_ate, 'dias_uteis_restantes', v_du_rest,
    'meta_empresa', v_meta_emp, 'meta_atingida', (v_hon >= v_meta_emp), 'necessidade_diaria', v_nec_dia,
    'proj_honorarios', v_proj_hon,
    'meta_pct', case when v_meta_emp > 0 then round(v_hon::numeric / v_meta_emp * 100, 1) else null end,
    'meta_falta', case when v_meta_emp > 0 then greatest(0, v_meta_emp - v_hon) else null end,
    'proj_honorarios_pct', case when v_meta_emp > 0 then round(v_proj_hon::numeric / v_meta_emp * 100, 1) else null end,
    'comparacao', jsonb_build_object('realizado', v_rec, 'projetado', v_proj_fech, 'diferenca', v_proj_fech - v_rec),
    'estimativa_aviso', 'Projeção estimada com base no ritmo atual.');

  -- (C) Tela "Metas": a linha 'empresa' segue a meta de honorários da competência.
  select jsonb_agg(m order by ord) into v_metas from (
    select 1 ord, public._tv_meta_obj('empresa','Meta da empresa', v_meta_emp, v_hon, 'mensal', v_proj_hon, v_du_rest) m
    union all select 2, public._tv_meta_obj('magic','Magic Number', 500000, v_hon, 'mensal', v_proj_hon, v_du_rest)
    union all select 3, public._tv_meta_obj('marco','Marco histórico', 3000000, v_hon_total, 'total', v_hon_total, v_du_rest)
  ) z;

  select jsonb_build_object(
      'mes_referencia', mp.mes_referencia,
      'base_operacional', round(mp.meta_operacional)::bigint,
      'reserva_unidades', round(mp.meta_unidades)::bigint,
      'meta_honorario',  round(mp.meta_honorario)::bigint,
      'faixas', jsonb_build_array(
        jsonb_build_object('marco','M1','percentual', mp.m1_percentual, 'valor', round(mp.m1_valor)::bigint,
                           'ate', round(mp.m2_valor)::bigint, 'desde_primeiro', (mp.m1_valor <= 1)),
        jsonb_build_object('marco','M2','percentual', mp.m2_percentual, 'valor', round(mp.m2_valor)::bigint),
        jsonb_build_object('marco','M3','percentual', mp.m3_percentual, 'valor', round(mp.m3_valor)::bigint),
        jsonb_build_object('marco','M4','percentual', mp.m4_percentual, 'valor', round(mp.m4_valor)::bigint, 'maxima', true)
      ))
    into v_premiacao
  from public.metas_projecao mp where mp.mes_referencia = v_mes limit 1;
  v_premiacao := coalesce(v_premiacao, '{}'::jsonb);

  v_rankings := jsonb_build_object(
    'melhor_dia', (select jsonb_build_object('operador', op) from (
        select upper(btrim(coalesce(nullif(operador_nome,''),operador_email))) op, sum(valor_pago) v, count(*) q
        from public.pagamentos where data_pagamento = current_date and lower(operador_email) = any(v_ops)
        group by 1 order by v desc, q desc, op asc limit 1) a),
    'melhor_mes', (select jsonb_build_object('operador', op) from (
        select upper(btrim(coalesce(nullif(operador_nome,''),operador_email))) op, sum(valor_pago) v, count(*) q
        from public.pagamentos where date_trunc('month',data_pagamento)=date_trunc('month',current_date) and lower(operador_email) = any(v_ops)
        group by 1 order by v desc, q desc, op asc limit 1) a),
    'top3_mes', coalesce((select jsonb_agg(jsonb_build_object('operador', op) order by v desc, q desc, op asc) from (
        select upper(btrim(coalesce(nullif(operador_nome,''),operador_email))) op, sum(valor_pago) v, count(*) q
        from public.pagamentos where date_trunc('month',data_pagamento)=date_trunc('month',current_date) and lower(operador_email) = any(v_ops)
        group by 1 order by v desc, q desc, op asc limit 3) a), '[]'::jsonb),
    'mais_pagos_dia', (select jsonb_build_object('operador', op, 'qtd', q) from (
        select upper(btrim(coalesce(nullif(operador_nome,''),operador_email))) op, count(*) q
        from public.pagamentos where data_pagamento = current_date and lower(operador_email) = any(v_ops)
        group by 1 order by q desc, op asc limit 1) a),
    'maior_pagamento_mes', (select jsonb_build_object('valor', round(valor_pago)::bigint,
          'operador', coalesce(nullif(operador_nome,''),operador_email,'-'))
        from public.pagamentos where date_trunc('month',data_pagamento)=date_trunc('month',current_date) and lower(operador_email) = any(v_ops)
        order by valor_pago desc nulls last limit 1));

  select ativo, valor into v_hist_ativo, v_hist_cfg from public.tv_config where chave='julho_historico';
  if coalesce(v_hist_ativo,false) then
    v_julho := jsonb_build_object('ativo', true,
      'titulo', coalesce(v_hist_cfg->>'titulo','Julho Histórico'),
      'texto_principal', v_hist_cfg->>'texto_principal', 'texto_complementar', v_hist_cfg->>'texto_complementar',
      'data_referencia', v_hist_cfg->>'data_referencia',
      'metas', jsonb_build_array(
        public._tv_meta_hist('Meta da empresa', 450000, v_hon),
        public._tv_meta_hist('Magic Number', 500000, v_hon),
        public._tv_meta_hist('Marco de R$ 3 milhões', 3000000, v_hon_total)));
  else v_julho := jsonb_build_object('ativo', false); end if;

  select coalesce(jsonb_agg(jsonb_build_object('titulo',titulo,'mensagem',texto,'prioridade',prioridade)
           order by prioridade desc, data_final asc nulls last, atualizado_em desc), '[]'::jsonb)
    into v_avisos from public.tv_mensagem_especial
  where ativo = true and (data_inicial is null or data_inicial <= current_date)
    and (data_final is null or data_final >= current_date);

  return jsonb_build_object(
    'dados', v_dados, 'proj', v_proj, 'rank', v_rank,
    'dicas', v_dicas, 'elogios', v_elogios, 'aniversariantes', v_aniv,
    'aniversariantes_hoje', v_aniv_hoje, 'mensagem_especial', v_msg,
    'hoje', v_hoje_obj, 'mes', v_mes_obj, 'metas', v_metas,
    'premiacao', v_premiacao,
    'rankings', v_rankings, 'julho_historico', v_julho, 'avisos', v_avisos);
end;
$function$;

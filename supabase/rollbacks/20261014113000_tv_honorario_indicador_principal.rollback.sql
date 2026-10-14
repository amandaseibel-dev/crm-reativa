-- ============================================================================
-- ROLLBACK de 20261014113000 — o telão volta a medir o valor BRUTO recuperado.
-- ============================================================================
-- Mesma técnica da migration, na direção inversa: lê o corpo VIVO de
-- tv_snapshot_calcular() com pg_get_functiondef, desfaz só os três trechos e
-- aborta se a âncora não aparecer exatamente uma vez.
--
-- O que volta ao que era:
--   hoje.maior_pagamento        perde 'honorario' e volta a ordenar por bruto
--   rankings.melhor_dia/_mes    voltam a ordenar por soma de valor_pago
--   rankings.top3_mes           idem
--   rankings.maior_pagamento_mes perde 'honorario'
--   mes.media_diaria_honorarios deixa de ser emitido
--
-- NENHUM DADO É TOCADO nos dois sentidos: pagamentos, acordos, títulos, metas e
-- os snapshots já gravados ficam exatamente como estão. Isto só reescreve a
-- função que MONTA o payload de leitura do telão. O próximo "Atualizar
-- projeção" regenera a fotografia no formato antigo.
--
-- A tela aguenta o rollback sem deploy: sem as chaves novas, os cards de
-- honorário por pagamento somem e a média diária de honorário mostra "Sem
-- registro", em vez de exibir bruto com rótulo de honorário.
-- ============================================================================

begin;

-- media_diaria_honorarios
do $patch$
declare
  v_src text; v_novo text; v_n int;
  v_de   text := $a$    'media_diaria', v_media_dia, 'media_diaria_honorarios', round(v_hon::numeric / v_du_ate),
    'projecao_fechamento', v_proj_fech,$a$;
  v_para text := $a$    'media_diaria', v_media_dia, 'projecao_fechamento', v_proj_fech,$a$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular' limit 1;
  if v_src is null then
    raise exception 'tv_snapshot_calcular() nao existe neste banco.';
  end if;

  if position(v_para in v_src) > 0 then
    raise notice 'media_diaria_honorarios: já estava no formato antigo; nada a fazer.';
    return;
  end if;

  v_n := (length(v_src) - length(replace(v_src, v_de, ''))) / length(v_de);
  if v_n <> 1 then
    raise exception 'ancora media_diaria_honorarios encontrada % vez(es) (esperado 1). Nada foi alterado.', v_n;
  end if;

  v_novo := replace(v_src, v_de, v_para);
  execute v_novo;
end
$patch$;

-- v_rankings
do $patch$
declare
  v_src text; v_novo text; v_n int;
  v_de   text := $a$  v_rankings := jsonb_build_object(
    'melhor_dia', (select jsonb_build_object('operador', op, 'honorario', h) from (
        select upper(btrim(coalesce(nullif(operador_nome,''),operador_email))) op,
               round(sum(valor_honorario))::bigint h, count(*) q
        from public.pagamentos where data_pagamento = current_date and lower(operador_email) = any(v_ops)
        group by 1 having sum(valor_honorario) > 0 order by h desc, q desc, op asc limit 1) a),
    'melhor_mes', (select jsonb_build_object('operador', op, 'honorario', h) from (
        select upper(btrim(coalesce(nullif(operador_nome,''),operador_email))) op,
               round(sum(valor_honorario))::bigint h, count(*) q
        from public.pagamentos where date_trunc('month',data_pagamento)=date_trunc('month',current_date) and lower(operador_email) = any(v_ops)
        group by 1 having sum(valor_honorario) > 0 order by h desc, q desc, op asc limit 1) a),
    'top3_mes', coalesce((select jsonb_agg(jsonb_build_object('operador', op, 'honorario', h) order by h desc, q desc, op asc) from (
        select upper(btrim(coalesce(nullif(operador_nome,''),operador_email))) op,
               round(sum(valor_honorario))::bigint h, count(*) q
        from public.pagamentos where date_trunc('month',data_pagamento)=date_trunc('month',current_date) and lower(operador_email) = any(v_ops)
        group by 1 having sum(valor_honorario) > 0 order by h desc, q desc, op asc limit 3) a), '[]'::jsonb),
    'mais_pagos_dia', (select jsonb_build_object('operador', op, 'qtd', q) from (
        select upper(btrim(coalesce(nullif(operador_nome,''),operador_email))) op, count(*) q
        from public.pagamentos where data_pagamento = current_date and lower(operador_email) = any(v_ops)
        group by 1 order by q desc, op asc limit 1) a),
    'maior_pagamento_mes', (select jsonb_build_object('valor', round(valor_pago)::bigint,
          'honorario', round(valor_honorario)::bigint,
          'operador', coalesce(nullif(operador_nome,''),operador_email,'-'))
        from public.pagamentos where date_trunc('month',data_pagamento)=date_trunc('month',current_date) and lower(operador_email) = any(v_ops)
          and coalesce(valor_honorario,0) > 0
        order by valor_honorario desc nulls last limit 1));$a$;
  v_para text := $a$  v_rankings := jsonb_build_object(
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
        order by valor_pago desc nulls last limit 1));$a$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular' limit 1;
  if v_src is null then
    raise exception 'tv_snapshot_calcular() nao existe neste banco.';
  end if;

  if position(v_para in v_src) > 0 then
    raise notice 'v_rankings: já estava no formato antigo; nada a fazer.';
    return;
  end if;

  v_n := (length(v_src) - length(replace(v_src, v_de, ''))) / length(v_de);
  if v_n <> 1 then
    raise exception 'ancora v_rankings encontrada % vez(es) (esperado 1). Nada foi alterado.', v_n;
  end if;

  v_novo := replace(v_src, v_de, v_para);
  execute v_novo;
end
$patch$;

-- maior_pagamento_dia
do $patch$
declare
  v_src text; v_novo text; v_n int;
  v_de   text := $a$  select jsonb_build_object('valor', round(valor_pago)::bigint,
           'honorario', round(valor_honorario)::bigint,
           'operador', coalesce(nullif(operador_nome,''), operador_email, '-'))
    into v_maior_dia from public.pagamentos where data_pagamento = current_date and lower(operador_email) = any(v_ops) and coalesce(valor_honorario,0) > 0 order by valor_honorario desc nulls last limit 1;$a$;
  v_para text := $a$  select jsonb_build_object('valor', round(valor_pago)::bigint,
           'operador', coalesce(nullif(operador_nome,''), operador_email, '-'))
    into v_maior_dia from public.pagamentos where data_pagamento = current_date and lower(operador_email) = any(v_ops) order by valor_pago desc nulls last limit 1;$a$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular' limit 1;
  if v_src is null then
    raise exception 'tv_snapshot_calcular() nao existe neste banco.';
  end if;

  if position(v_para in v_src) > 0 then
    raise notice 'maior_pagamento_dia: já estava no formato antigo; nada a fazer.';
    return;
  end if;

  v_n := (length(v_src) - length(replace(v_src, v_de, ''))) / length(v_de);
  if v_n <> 1 then
    raise exception 'ancora maior_pagamento_dia encontrada % vez(es) (esperado 1). Nada foi alterado.', v_n;
  end if;

  v_novo := replace(v_src, v_de, v_para);
  execute v_novo;
end
$patch$;

commit;

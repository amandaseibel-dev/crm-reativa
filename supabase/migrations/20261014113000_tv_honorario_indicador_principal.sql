-- =============================================================================
-- TV ReATIVA — o indicador financeiro principal passa a ser HONORÁRIO RECEBIDO
-- -----------------------------------------------------------------------------
-- O telão já media a META em honorário (metas_projecao.meta_honorario x soma de
-- `valor_honorario` dos pagamentos) desde 20260811200000, mas as telas de
-- OPERAÇÃO e os RANKINGS ainda coroavam o valor BRUTO pago pelo aluno. Isso
-- premiava quem traz volume e não quem traz receita — e mostrava dois campeões
-- diferentes em telas seguidas.
--
-- Esta migration só ACRESCENTA o honorário onde ele faltava no payload e troca
-- o CRITÉRIO DE ORDENAÇÃO dos rankings de operador. Em números:
--
--   hoje.maior_pagamento        + 'honorario'  e passa a ser o pagamento que
--                                 mais trouxe honorário no dia (o bruto segue
--                                 no mesmo objeto, em 'valor')
--   mes.media_diaria_honorarios NOVO — honorário do mês / dias úteis
--                                 transcorridos. `mes.media_diaria` CONTINUA
--                                 existindo e continua sendo o bruto: nada que
--                                 já lê aquela chave muda de valor.
--   rankings.melhor_dia         ordenação por soma de honorário (era valor_pago)
--   rankings.melhor_mes         idem, + 'honorario' no objeto
--   rankings.top3_mes           idem, + 'honorario' em cada item
--   rankings.maior_pagamento_mes + 'honorario', ordenado por honorário
--
-- INTEGRIDADE, item por item do pedido:
--   • fonte única `public.pagamentos` — a tabela de pagamento CONFIRMADO. O
--     snapshot nunca leu negociação/acordo em aberto nem parcela a vencer, e
--     isso não muda aqui. Nenhuma linha nova de FROM entra na função.
--   • nada de estimar honorário por percentual: todo valor vem de
--     `valor_honorario`, o campo efetivamente registrado no pagamento.
--   • pagamento DIRETO, sem honorário nosso, sai dos destaques e dos rankings:
--     `coalesce(valor_honorario,0) > 0` nos maiores pagamentos e
--     `having sum(valor_honorario) > 0` nos agrupamentos por operador. Ele
--     continua somando no BRUTO recuperado, que é o que ele é.
--   • sem duplicidade: um pagamento = uma linha; os agrupamentos seguem por
--     `lower(operador_email)` normalizado, como já era.
--
-- NÃO MEXE EM DADO HISTÓRICO. Nenhum insert, update ou delete em pagamentos,
-- acordos, títulos, metas ou no snapshot gravado. É só a função que MONTA o
-- payload de leitura do telão; o próximo "Atualizar projeção" regenera a
-- fotografia. A tela aguenta snapshot antigo: sem as chaves novas, o card não
-- aparece em vez de mostrar bruto com rótulo de honorário.
--
-- POR QUE PATCH ANCORADO e não CREATE OR REPLACE do arquivo do repositório:
-- tv_snapshot_calcular() tem ~230 linhas e produção já recebeu patches
-- ancorados de outras frentes (20261006110000, 20261006200000, 20261007103000).
-- Reescrever a função a partir do texto versionado apagaria esses ajustes em
-- silêncio. Aqui o corpo VIVO é lido com pg_get_functiondef, só os três trechos
-- são trocados, cada bloco ABORTA se a âncora não aparecer exatamente uma vez,
-- e repetir a migration é inofensivo (cada bloco reconhece o próprio efeito).
--
-- DESFAZER: supabase/rollbacks/20261014113000_tv_honorario_indicador_principal.rollback.sql
-- =============================================================================

-- 1) maior pagamento do dia: o honorário entra no objeto e passa a ordenar
do $patch$
declare
  v_src text; v_novo text; v_n int;
  v_de   text := $a$  select jsonb_build_object('valor', round(valor_pago)::bigint,
           'operador', coalesce(nullif(operador_nome,''), operador_email, '-'))
    into v_maior_dia from public.pagamentos where data_pagamento = current_date and lower(operador_email) = any(v_ops) order by valor_pago desc nulls last limit 1;$a$;
  v_para text := $a$  select jsonb_build_object('valor', round(valor_pago)::bigint,
           'honorario', round(valor_honorario)::bigint,
           'operador', coalesce(nullif(operador_nome,''), operador_email, '-'))
    into v_maior_dia from public.pagamentos where data_pagamento = current_date and lower(operador_email) = any(v_ops) and coalesce(valor_honorario,0) > 0 order by valor_honorario desc nulls last limit 1;$a$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular' limit 1;
  if v_src is null then
    raise exception 'tv_snapshot_calcular() nao existe neste banco.';
  end if;

  if position(v_para in v_src) > 0 or position($j$'honorario', round(valor_honorario)::bigint,
           'operador', coalesce(nullif(operador_nome,''), operador_email, '-'))
    into v_maior_dia$j$ in v_src) > 0 then
    raise notice 'maior_pagamento_dia: já aplicado; nada a fazer.';
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

-- 2) rankings de operador: critério passa a ser honorário recebido
do $patch$
declare
  v_src text; v_novo text; v_n int;
  v_de   text := $a$  v_rankings := jsonb_build_object(
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
  v_para text := $a$  v_rankings := jsonb_build_object(
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
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular' limit 1;
  if v_src is null then
    raise exception 'tv_snapshot_calcular() nao existe neste banco.';
  end if;

  if position(v_para in v_src) > 0 or position($j$'melhor_dia', (select jsonb_build_object('operador', op, 'honorario', h)$j$ in v_src) > 0 then
    raise notice 'v_rankings: já aplicado; nada a fazer.';
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

-- 3) média diária em honorário (a de bruto continua, intocada)
do $patch$
declare
  v_src text; v_novo text; v_n int;
  v_de   text := $a$    'media_diaria', v_media_dia, 'projecao_fechamento', v_proj_fech,$a$;
  v_para text := $a$    'media_diaria', v_media_dia, 'media_diaria_honorarios', round(v_hon::numeric / v_du_ate),
    'projecao_fechamento', v_proj_fech,$a$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular' limit 1;
  if v_src is null then
    raise exception 'tv_snapshot_calcular() nao existe neste banco.';
  end if;

  if position(v_para in v_src) > 0 or position($j$'media_diaria_honorarios'$j$ in v_src) > 0 then
    raise notice 'media_diaria_honorarios: já aplicado; nada a fazer.';
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

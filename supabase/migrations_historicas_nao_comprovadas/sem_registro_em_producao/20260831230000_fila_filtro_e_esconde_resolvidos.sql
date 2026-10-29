-- Filtro por tipo de divida, e a fila para de mostrar quem nao tem o que decidir.
--
-- Amanda, 31/08, dois pedidos que sao o mesmo:
--   "coloca um filtro de quem tem mensalidade ou so acordo"
--   "se nao tem mensalidade, parcelas estao em dia e tem operador responsavel,
--    o que faz na fila?"
--
-- A fila serve para VINCULAR o acordo a mensalidade paga. Quem nao tem
-- mensalidade em aberto nao tem o que vincular; se ainda por cima esta com as
-- parcelas em dia e ja tem operador, nao ha decisao humana nenhuma a tomar.
--
-- Medido em 31/08, julho + agosto:
--   tem mensalidade -> precisa vincular      1.193   R$ 1.670.995,66
--   acordo com parcela VENCIDA                 478   R$ 1.205.372,98
--   em dia, com operador -> SAI DA FILA         256   R$   837.862,30
--   sem operador responsavel                    14   R$    25.071,49
--   dinheiro sem dono                           53   R$    70.228,34
--
-- p_tipo_divida:
--   null (padrao)   esconde os "em dia + com operador"; e o que ha a fazer
--   'MENSALIDADE'   so quem tem mensalidade em aberto
--   'ACORDO'        so quem nao tem mensalidade em aberto
--   'TUDO'          traz todo mundo de volta, inclusive os resolvidos
--
-- POR QUE NO BANCO E NAO NA TELA: a tela carrega 300 linhas de ~1.900. Filtrar o
-- que ja veio daria um recorte enganoso -- ainda mais com a ordem priorizando
-- mensalidade, o que faria "so acordo" parecer quase vazio.
--
-- NOTA DE PROCESSO. A primeira tentativa desta migration acrescentou o parametro
-- e a troca do WHERE NAO casou -- e eu so tinha validado a troca da assinatura.
-- A funcao ficou aceitando o filtro e ignorando-o em silencio, devolvendo o mesmo
-- resultado para 'MENSALIDADE' e 'ACORDO'. Por isso aqui cada troca e conferida,
-- e no fim se relê a funcao para confirmar que o filtro entrou.
--
-- DESFAZER: supabase/rollbacks/20260831230000_fila_filtro_e_esconde_resolvidos.rollback.sql

do $do$
declare v_def text; v_novo text; v_anchor text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='conferencia_pagamentos';

  if v_def is null then
    raise exception 'conferencia_pagamentos nao existe -- migration fora de ordem';
  end if;

  -- 1) parametro novo, se ainda nao existir
  if v_def not like '%p_tipo_divida%' then
    v_novo := replace(v_def,
      'p_ate date DEFAULT NULL::date)',
      'p_ate date DEFAULT NULL::date, p_tipo_divida text DEFAULT NULL::text)');
    if v_novo = v_def then raise exception 'assinatura nao casou -- nada alterado'; end if;
    -- dinheiro sem dono nao tem divida para classificar
    v_novo := replace(v_novo,
      'having sum(n.valor_pago) >= coalesce(p_valor_min,0)',
      'having sum(n.valor_pago) >= coalesce(p_valor_min,0) and p_tipo_divida is null');
    execute 'drop function if exists public.conferencia_pagamentos(date, numeric, integer, date)';
    execute v_novo;
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='conferencia_pagamentos';
  end if;

  -- 2) o filtro em si
  if v_def like '%p_tipo_divida) = ''MENSALIDADE''%' then return; end if;

  v_anchor := 'and coalesce(u.entrou,0) >= coalesce(p_valor_min,0)';
  if position(v_anchor in v_def) = 0 then
    raise exception 'ancora do WHERE nao encontrada -- nada alterado';
  end if;

  v_novo := replace(v_def, v_anchor, v_anchor || '
       -- Sem mensalidade, nada vencido e com dono definido: nao ha o que decidir.
       and (upper(coalesce(p_tipo_divida,'''')) = ''TUDO''
            or coalesce(tt.titulos,0) > 0.005
            or coalesce(al.saldo_vencido,0) > 0.005
            or coalesce(al.responsavel_atual_nome,'''') = '''')
       -- filtro: so mensalidade, ou so acordo
       and (p_tipo_divida is null
            or upper(p_tipo_divida) = ''TUDO''
            or (upper(p_tipo_divida) = ''MENSALIDADE'' and coalesce(tt.titulos,0) > 0.005)
            or (upper(p_tipo_divida) = ''ACORDO''      and coalesce(tt.titulos,0) <= 0.005))');

  if v_novo = v_def then raise exception 'replace do filtro nao alterou nada'; end if;
  execute v_novo;

  -- 3) confere que entrou de verdade
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='conferencia_pagamentos';
  if v_def not like '%p_tipo_divida) = ''MENSALIDADE''%' then
    raise exception 'a funcao nao ficou com o filtro -- verifique';
  end if;
end $do$;

revoke all on function public.conferencia_pagamentos(date, numeric, integer, date, text) from public, anon;
grant execute on function public.conferencia_pagamentos(date, numeric, integer, date, text) to authenticated, service_role;

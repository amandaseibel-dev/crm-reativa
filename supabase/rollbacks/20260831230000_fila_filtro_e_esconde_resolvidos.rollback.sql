-- DESFAZER 20260831230000_fila_filtro_e_esconde_resolvidos.sql
--
-- ATENCAO: a tela passa a chamar a funcao com `p_tipo_divida`. Removendo o
-- parametro sem voltar o front junto, a chamada quebra. Desfaca os dois ou
-- nenhum.
--
-- Desfazer tambem traz de volta para a fila as 256 pessoas que nao tem
-- mensalidade, estao com as parcelas em dia e ja tem operador -- as que a Amanda
-- apontou como "o que faz na fila?".
--
-- Para so PARAR DE ESCONDER sem perder o filtro, nao precisa de migration:
-- basta a tela chamar sempre com 'TUDO'.

do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='conferencia_pagamentos';

  -- tira o bloco do filtro
  v_novo := regexp_replace(v_def,
    E'\\n[^\\n]*-- Sem mensalidade, nada vencido.*?coalesce\\(tt\\.titulos,0\\) <= 0\\.005\\)\\)', '', 'ns');
  v_novo := replace(v_novo,
    'having sum(n.valor_pago) >= coalesce(p_valor_min,0) and p_tipo_divida is null',
    'having sum(n.valor_pago) >= coalesce(p_valor_min,0)');
  v_novo := replace(v_novo,
    'p_ate date DEFAULT NULL::date, p_tipo_divida text DEFAULT NULL::text)',
    'p_ate date DEFAULT NULL::date)');

  if v_novo = v_def then
    raise exception 'nada a desfazer -- a funcao nao esta na versao com filtro';
  end if;

  execute 'drop function if exists public.conferencia_pagamentos(date, numeric, integer, date, text)';
  execute v_novo;
end $do$;

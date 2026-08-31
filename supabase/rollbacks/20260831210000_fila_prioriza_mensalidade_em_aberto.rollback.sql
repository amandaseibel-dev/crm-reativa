-- DESFAZER 20260831210000_fila_prioriza_mensalidade_em_aberto.sql
--
-- Volta a ordenar pelo valor que entrou. Nada quebra -- so muda a ordem de
-- trabalho, e a fila volta a comecar por pagamentos grandes de gente cujo saldo
-- e so parcela de acordo.

do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='conferencia_pagamentos';

  v_novo := regexp_replace(v_def,
    E'\\n[^\\n]*-- MENSALIDADE EM ABERTO PRIMEIRO.*?\\n[^\\n]*t\\.x_mens desc, ',
    E'\\n            ', 'ns');

  if v_novo = v_def then
    raise exception 'nada a desfazer -- a funcao nao esta na versao com prioridade de mensalidade';
  end if;
  execute v_novo;
end $do$;

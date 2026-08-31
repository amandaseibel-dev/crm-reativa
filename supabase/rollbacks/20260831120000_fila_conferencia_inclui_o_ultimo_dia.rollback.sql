-- DESFAZER 20260831120000_fila_conferencia_inclui_o_ultimo_dia.sql
--
-- ATENCAO: desfazer volta a ESCONDER o ultimo dia do periodo na fila de
-- conferencia. Em julho de 2026 isso eram 75 pessoas e R$ 271.054,84 de
-- dinheiro que entrou, precisa de baixa e nao aparece para ninguem.
--
-- Nao ha motivo legitimo conhecido para desfazer. Esta aqui so pela regra da
-- casa de toda migration ter volta.

do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'conferencia_pagamentos';

  v_novo := replace(v_def,
    'declare v_ate date := coalesce(p_ate + 1, date ''2999-12-31'');',
    'declare v_ate date := coalesce(p_ate, date ''2999-12-31'');');

  if v_novo = v_def then
    raise exception 'nada a desfazer -- a funcao nao esta na versao corrigida';
  end if;

  execute v_novo;
end $do$;

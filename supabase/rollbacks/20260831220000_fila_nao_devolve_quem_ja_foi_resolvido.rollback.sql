-- DESFAZER 20260831220000_fila_nao_devolve_quem_ja_foi_resolvido.sql
--
-- ATENCAO: desfazer faz a fila voltar a devolver quem acabou de ser resolvido.
-- Em 31/08 eram 78 pessoas reaparecendo com "entrou = 0" logo depois de terem
-- sido conferidas -- quanto mais se trabalha, mais a fila devolve.

do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='conferencia_pagamentos';

  v_novo := replace(v_def,
    'from pg left join bx on bx.aid = pg.aid',
    'from pg full outer join bx on bx.aid = pg.aid');

  if v_novo = v_def then
    raise exception 'nada a desfazer -- a funcao nao esta na versao corrigida';
  end if;
  execute v_novo;
end $do$;

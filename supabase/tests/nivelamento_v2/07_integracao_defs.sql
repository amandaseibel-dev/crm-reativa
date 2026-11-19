-- CHECAGEM NO BANCO: o sha256 de pg_get_functiondef de cada funcao importada deve
-- ser igual ao sha declarado no export. Usa _esperado (gerado pelo importador).
\set ON_ERROR_STOP on
do $$
declare n int; total int;
begin
  select count(*) into total from _esperado;
  if total = 0 then raise exception 'FALHOU: nenhuma funcao esperada'; end if;
  select count(*) into n
    from _esperado e
    join pg_namespace ns on ns.nspname = e.schema_nome
    join pg_proc p on p.pronamespace = ns.oid and p.proname = e.nome
                  and pg_get_function_identity_arguments(p.oid) = e.args
   where encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') <> e.sha;
  if n > 0 then raise exception 'FALHOU: % funcao(oes) com sha divergente no banco', n; end if;
  raise notice 'OK: % funcoes conferidas no banco por sha256', total;
end $$;

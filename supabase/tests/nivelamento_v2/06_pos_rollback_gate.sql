-- ESTADO APOS O ROLLBACK DO GATE (explicito): a brecha volta. Verificado aqui.
\set ON_ERROR_STOP on
do $$
begin
  if position('or auth.jwt() is null' in pg_get_functiondef(
       (select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='calibragem_teste_gate'))) = 0 then
    raise exception 'FALHOU: rollback do gate nao restaurou a forma anterior';
  end if;
  raise notice 'OK: rollback do gate restaurou a forma anterior (brecha reaberta, conforme decisao)';
end $$;

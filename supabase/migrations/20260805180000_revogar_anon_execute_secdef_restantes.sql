-- ============================================================================
-- Bloco 5 — Revoga EXECUTE de anon/PUBLIC em TODAS as funções SECURITY DEFINER
-- ainda alcançáveis por anon (a maioria trigger functions + helpers de dados como
-- _relatorio_2026_1_eleg, contar_carteira_ativa, acoes_massivas_filtros).
-- O app é 100% autenticado; nenhuma dessas precisa de anon. authenticated e
-- service_role permanecem. Fecha "RPC sensível executável por PUBLIC/anon".
-- ============================================================================
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text sig
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    execute format('revoke execute on function %s from anon, public', r.sig);
  end loop;
end $$;

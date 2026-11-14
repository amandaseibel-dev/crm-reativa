-- ROLLBACK, PARTE 2 (ACL). Executar DEPOIS de 20261112230000_prime_protege_decisao_humana.rollback.sql.
-- Restaura EXECUTE apenas para service_role, como em producao (owner postgres).
-- O CREATE OR REPLACE acima pode repor o EXECUTE padrao para PUBLIC: estes comandos o retiram.

revoke all on function public.prime_liquidacao_suspender(uuid, text, text, text, text, jsonb, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.prime_liquidacao_suspender(uuid, text, text, text, text, jsonb, uuid, uuid, text) to service_role;
revoke all on function public.prime_liquidacao_reavaliar_pendentes(text) from public, anon, authenticated;
grant execute on function public.prime_liquidacao_reavaliar_pendentes(text) to service_role;

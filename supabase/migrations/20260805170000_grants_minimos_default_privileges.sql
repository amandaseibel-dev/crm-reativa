-- ============================================================================
-- Bloco 4 — Redução de privilégios amplos + default privileges seguros.
-- App é login-gated (getSession antes de renderizar; login via schema auth).
-- Nenhuma leitura de tabela public roda como anon → revogar anon é seguro
-- (RLS já retornava 0). authenticated perde apenas privilégios NUNCA usados
-- via PostgREST (TRUNCATE/REFERENCES/TRIGGER). RLS permanece como camada.
-- service_role/postgres preservados. Não altera dados.
-- ============================================================================

-- 1) anon: sem qualquer privilégio operacional em tabelas/sequences public.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- 2) authenticated: remove privilégios de tabela nunca usados pelo cliente.
--    Mantém SELECT/INSERT/UPDATE/DELETE (gateados por RLS).
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated;

-- 3) Default privileges seguros para NOVOS objetos criados nesta linha (postgres):
--    novas tabelas não concedem nada a anon; novas funções não ficam executáveis
--    por PUBLIC/anon (deny-by-default — cada RPC deve conceder EXECUTE explicitamente).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL     ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL     ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS  FROM PUBLIC, anon;

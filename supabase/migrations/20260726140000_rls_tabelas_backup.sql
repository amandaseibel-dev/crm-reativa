-- Hardening de segurança: proteger tabelas de BACKUP/LOG com RLS.
--
-- Contexto (diagnóstico read-only em produção, branch security/rls-tabelas-backup):
-- 7 tabelas em public estavam com RLS DESABILITADO e com grants totais
-- (SELECT/INSERT/UPDATE/DELETE/TRUNCATE) para anon e authenticated. Elas contêm
-- dados pessoais (CPF, nome, telefone, e-mail) e financeiros (valores, honorários,
-- pagamentos). São cópias de segurança / logs, NÃO consumidas pelo frontend nem
-- por RPCs chamadas pelo app.
--
-- Objetivo:
--   * anon                -> sem acesso
--   * operador/authenticated comum -> sem acesso
--   * service_role        -> preservado (bypassa RLS por atributo BYPASSRLS)
--   * postgres (owner)    -> preservado (owner bypassa RLS; usado pelo SQL Editor,
--                            rotinas administrativas e funções SECURITY DEFINER de rollback)
--   * Amanda/Fernanda     -> acesso apenas pelo caminho administrativo (SQL Editor =
--                            postgres / service_role). NÃO se cria policy para a role
--                            `authenticated` porque NENHUM fluxo operacional precisa
--                            ler esses backups — é a política mínima indispensável.
--
-- Segurança preservada:
--   * As 3 funções que tocam log_quitacao_bloqueada
--     (avaliar_quitacao_aluno, confirmar_baixa_caso, liberar_caso_por_evento)
--     são SECURITY DEFINER, owner=postgres -> continuam gravando o log normalmente,
--     pois rodam como owner e bypassam RLS.
--   * Nenhum trigger, view do app ou referência de frontend usa estas tabelas.
--   * NÃO altera nem exclui dados. Apenas RLS + grants.
--
-- Idempotente: pode ser reaplicada sem erro; ignora tabelas ausentes.

BEGIN;

DO $$
DECLARE
  t text;
  tabelas text[] := ARRAY[
    '_bkp_quitacao_sem_liberacao_20260724',
    'backup_estorno_ana_petry_20260726',
    'backup_rh_ana_petry_20260726',
    'bkp_piloto_aluno_20260725',
    'bkp_piloto_casos_20260725',
    'bkp_piloto_solic_20260725',
    'log_quitacao_bloqueada'
  ];
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'Tabela public.% ausente, ignorando.', t;
      CONTINUE;
    END IF;

    -- 1) Habilita RLS (sem FORCE: owner postgres e service_role continuam com bypass).
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);

    -- 2) Revoga qualquer acesso das roles operacionais.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC;', t);

    -- 3) Garante grants administrativos (idempotente; service_role bypassa RLS de todo modo).
    EXECUTE format('GRANT ALL ON public.%I TO service_role;', t);
    EXECUTE format('GRANT ALL ON public.%I TO postgres;', t);

    RAISE NOTICE 'RLS habilitado e grants operacionais revogados em public.%', t;
  END LOOP;
END $$;

-- 4) Sem CREATE POLICY: com RLS habilitada e nenhuma policy, a role `authenticated`
--    (operadores e demais usuários do app) fica sem qualquer linha visível — que é o
--    comportamento desejado. service_role e postgres seguem com acesso por bypass.
--
--    Se, no futuro, Amanda/Fernanda precisarem consultar um backup DIRETAMENTE pela role
--    `authenticated` (e não pelo SQL Editor), habilite pontualmente algo como o template
--    abaixo — mantendo o allowlist restrito e ajustando o e-mail exato da Fernanda:
--
--    -- GRANT SELECT ON public.<tabela> TO authenticated;
--    -- CREATE POLICY backup_admin_select ON public.<tabela>
--    --   FOR SELECT TO authenticated
--    --   USING (lower(coalesce((auth.jwt() ->> 'email'), '')) = ANY (ARRAY[
--    --     'amanda.seibel@aelbra.com.br'
--    --     -- , '<email_da_fernanda>@aelbra.com.br'
--    --   ]));

COMMIT;

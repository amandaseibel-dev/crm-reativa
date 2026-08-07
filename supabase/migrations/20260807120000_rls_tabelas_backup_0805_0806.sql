-- Hardening de segurança / LGPD: proteger com RLS as tabelas de BACKUP/SNAPSHOT
-- criadas em 05-06/08/2026 (posteriores à blindagem de 26/07 em
-- 20260726140000_rls_tabelas_backup.sql, por isso ficaram de fora).
--
-- Contexto (diagnóstico read-only em produção, advisors de segurança do Supabase):
-- 10 tabelas em public estavam com RLS DESABILITADO. Não há acesso anônimo
-- (anon SELECT = false), MAS qualquer usuário `authenticated` (qualquer operador
-- logado) conseguia lê-las via API, expondo PII (nome/CPF/telefone/e-mail) e dados
-- financeiros de alunos que não são da carteira dele — furando o isolamento por
-- operador das tabelas vivas. São cópias de segurança / snapshots, NÃO consumidas
-- pelo frontend nem por RPCs chamadas pelo app.
--
-- Objetivo (mesmo padrão da migration 20260726140000):
--   * anon                          -> sem acesso (já era)
--   * operador/authenticated comum  -> sem acesso (FECHA a exposição atual)
--   * service_role                  -> preservado (BYPASSRLS)
--   * postgres (owner)              -> preservado (owner bypassa RLS; SQL Editor,
--                                      rotinas administrativas, rollback)
--   * Amanda/Fernanda               -> acesso apenas pelo caminho administrativo
--                                      (SQL Editor = postgres / service_role).
--
-- NÃO altera nem exclui dados. Apenas RLS + grants.
-- Idempotente: pode ser reaplicada sem erro; ignora tabelas ausentes
-- (ex.: em staging, onde esses backups de produção não existem — vira no-op).

BEGIN;

DO $$
DECLARE
  t text;
  tabelas text[] := ARRAY[
    '_backup_confirmacoes_saldo_zero_20260806',
    '_backup_move_sem_saldo_casos_20260806',
    '_backup_move_sem_saldo_alunos_20260806',
    '_backup_fila_acordos_saldo_zero_20260806',
    '_backup_fila_acordos_vinculo_20260806',
    '_backup_fila_acordos_vinculo_ambig_20260806',
    '_alvo_replicas_dedupe_20260805',
    '_backup_acordos_dup_reimport_20260805',
    '_backup_parcelas_dup_reimport_20260805',
    '_backup_parcelas_baixa_pago_20260805'
  ];
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'Tabela public.% ausente, ignorando.', t;
      CONTINUE;
    END IF;

    -- 1) Habilita RLS (sem FORCE: owner postgres e service_role mantêm bypass).
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);

    -- 2) Revoga qualquer acesso das roles operacionais.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC;', t);

    -- 3) Garante grants administrativos (idempotente; service_role bypassa RLS).
    EXECUTE format('GRANT ALL ON public.%I TO service_role;', t);
    EXECUTE format('GRANT ALL ON public.%I TO postgres;', t);

    RAISE NOTICE 'RLS habilitado e grants operacionais revogados em public.%', t;
  END LOOP;
END $$;

-- Sem CREATE POLICY: com RLS habilitada e nenhuma policy, a role `authenticated`
-- fica sem qualquer linha visível — comportamento desejado. service_role e postgres
-- seguem com acesso por bypass.

COMMIT;

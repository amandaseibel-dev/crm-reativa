-- ROLLBACK de 20260726140000_rls_tabelas_backup.sql
--
-- Restaura o estado ANTERIOR ao hardening: RLS desabilitado e grants totais
-- para anon e authenticated (como estava no diagnóstico).
--
-- ATENÇÃO: este down REEXPÕE dados pessoais/financeiros de backup para anon e
-- authenticated. Use apenas se o hardening quebrar alguma rotina administrativa
-- legítima. NÃO altera nem exclui dados.
--
-- Idempotente; ignora tabelas ausentes.

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

    -- Remove eventual policy administrativa criada manualmente pelo template.
    EXECUTE format('DROP POLICY IF EXISTS backup_admin_select ON public.%I;', t);

    -- Desabilita RLS.
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY;', t);

    -- Restaura grants totais (estado original do diagnóstico).
    EXECUTE format('GRANT ALL ON public.%I TO anon;', t);
    EXECUTE format('GRANT ALL ON public.%I TO authenticated;', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role;', t);
    EXECUTE format('GRANT ALL ON public.%I TO postgres;', t);

    RAISE NOTICE 'RLS desabilitado e grants restaurados em public.%', t;
  END LOOP;
END $$;

COMMIT;

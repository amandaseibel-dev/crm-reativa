-- Rollback de 20261113000000_relatorio_2026_2_sem_negociacao.sql.
-- Remove apenas os objetos criados para 2026/2. Não toca 2026/1 nem acordos, títulos ou pagamentos.
-- Aborta se já houver snapshots capturados: apagar histórico exige decisão da gestão e backup prévio.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.relatorio_mens_2026_2_snapshot) THEN
    RAISE EXCEPTION 'rollback abortado: relatorio_mens_2026_2_snapshot tem dados capturados';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.relatorio_mensalidades_2026_2_capturar();
DROP FUNCTION IF EXISTS public.relatorio_mensalidades_2026_2_sem_negociacao();
DROP FUNCTION IF EXISTS public._relatorio_2026_2_eleg();
DROP FUNCTION IF EXISTS public._cpf_valido_2026_2(text);
DROP TABLE IF EXISTS public.relatorio_mens_2026_2_snapshot;

COMMIT;

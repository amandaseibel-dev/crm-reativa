-- Rollback de 20261113000000_relatorio_2026_2_sem_negociacao.sql.
-- Remove as funcoes de 2026/2. Nao toca 2026/1, acordos, titulos ou pagamentos.
-- Lock ACCESS EXCLUSIVE na tabela de snapshot antes de qualquer verificacao, mantido ate o COMMIT:
-- nenhuma captura concorrente consegue inserir entre a checagem e o DROP.
-- Sem historico: remove tambem a tabela.
-- Com historico: preserva a tabela (RLS ativa, sem grants) e so remove as funcoes (reversao nao destrutiva).

BEGIN;

LOCK TABLE public.relatorio_mens_2026_2_snapshot IN ACCESS EXCLUSIVE MODE;

DROP FUNCTION IF EXISTS public.relatorio_mensalidades_2026_2_capturar();
DROP FUNCTION IF EXISTS public.relatorio_mensalidades_2026_2_sem_negociacao();
DROP FUNCTION IF EXISTS public._relatorio_2026_2_eleg();
DROP FUNCTION IF EXISTS public._cpf_valido_2026_2(text);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.relatorio_mens_2026_2_snapshot) THEN
    RAISE NOTICE 'snapshot 2026/2 com historico: tabela preservada (RLS ativa, sem grants)';
  ELSE
    DROP TABLE public.relatorio_mens_2026_2_snapshot;
  END IF;
END $$;

COMMIT;

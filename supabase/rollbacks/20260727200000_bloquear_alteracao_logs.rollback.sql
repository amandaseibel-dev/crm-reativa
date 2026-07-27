-- ROLLBACK de security/bloquear-alteracao-logs
-- Restaura o estado ANTERIOR das policies (reabre UPDATE/DELETE a authenticated não-painel).
-- Usar somente se a correção precisar ser revertida.

BEGIN;

-- 1) aluno_movimentacoes: recriar policy de UPDATE original.
DROP POLICY IF EXISTS aluno_movimentacoes_update ON public.aluno_movimentacoes;
CREATE POLICY aluno_movimentacoes_update ON public.aluno_movimentacoes
  FOR UPDATE TO authenticated USING (NOT eh_painel());

-- 2) Tabelas com painel_negado: recriar a policy ALL original e remover as SELECT/INSERT novas.
DO $$
DECLARE
  t text;
  tabelas text[] := ARRAY[
    'historico_alteracoes_crm',
    'historico_links_pagamento',
    'historico_agendamentos',
    'historico_operadores_alunos',
    'links_pagamento_historico',
    'historico_atendimentos',
    'historico_casos'
  ];
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    EXECUTE format('DROP POLICY IF EXISTS painel_negado_select ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY painel_negado ON public.%I FOR ALL TO authenticated USING (NOT eh_painel())', t);
  END LOOP;
END $$;

COMMIT;

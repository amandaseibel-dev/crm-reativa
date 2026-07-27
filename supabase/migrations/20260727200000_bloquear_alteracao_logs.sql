-- security/bloquear-alteracao-logs
-- Torna as tabelas de log/auditoria IMUTÁVEIS para o role authenticated:
-- nenhum UPDATE ou DELETE direto (operador, gestão, inativo, sem cadastro).
-- SELECT e INSERT legítimos preservados exatamente.
-- Alterações internas continuam via RPC/trigger SECURITY DEFINER (owner postgres),
-- service_role (BYPASSRLS) e postgres — nada disso passa por policy de authenticated.
--
-- Contexto do buraco encontrado:
--  * aluno_movimentacoes tinha policy UPDATE `aluno_movimentacoes_update` USING (NOT eh_painel())
--    -> qualquer authenticated não-painel podia ALTERAR o log. REMOVIDA.
--  * demais 7 tabelas tinham uma policy `painel_negado` cmd=ALL USING (NOT eh_painel()),
--    permissiva -> era o ÚNICO grant de UPDATE/DELETE, liberando alteração/exclusão a
--    qualquer authenticated não-painel. Substituída por policies SELECT + INSERT de mesma
--    semântica, sem cobrir UPDATE/DELETE.

BEGIN;

-- 1) aluno_movimentacoes: remover grant de UPDATE (DELETE já não possuía policy).
DROP POLICY IF EXISTS aluno_movimentacoes_update ON public.aluno_movimentacoes;

-- 2) Tabelas com `painel_negado` (ALL): reduzir escopo para SELECT + INSERT,
--    preservando comportamento atual e eliminando UPDATE/DELETE.
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
    EXECUTE format('DROP POLICY IF EXISTS painel_negado ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY painel_negado_select ON public.%I FOR SELECT TO authenticated USING (NOT eh_painel())', t);
    EXECUTE format(
      'CREATE POLICY painel_negado_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (NOT eh_painel())', t);
  END LOOP;
END $$;

COMMIT;

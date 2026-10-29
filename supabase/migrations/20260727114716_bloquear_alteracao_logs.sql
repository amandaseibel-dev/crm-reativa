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
--    permissiva -> era o ÚNICO grant de UPDATE/DELETE, e ainda liberava INSERT amplo
--    (apenas NOT eh_painel(), sem titularidade). Substituída SOMENTE por painel_negado_select.
--    INSERT passa a depender exclusivamente das policies específicas já existentes
--    (com app_usuario_ativo() + titularidade). UPDATE/DELETE ficam sem policy p/ authenticated.

BEGIN;

-- 1) aluno_movimentacoes: remover grant de UPDATE (DELETE já não possuía policy).
DROP POLICY IF EXISTS aluno_movimentacoes_update ON public.aluno_movimentacoes;

-- 2) Tabelas com `painel_negado` (ALL): reduzir escopo APENAS para SELECT.
--    NÃO criar painel_negado_insert: o INSERT fica a cargo exclusivo das policies
--    específicas já existentes (titularidade real). UPDATE/DELETE ficam sem policy.
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
  END LOOP;
END $$;

COMMIT;

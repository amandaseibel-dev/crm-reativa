-- ============================================================================
-- HOTFIX SEGURANÇA — view public.calibragem_saldo_aluno
-- Problema: security_invoker=off + grants a anon/authenticated → operador/anon
-- liam saldo (e CPF) de TODA a base por chamada direta (bypass de RLS).
-- Consumo real: SÓ por RPCs SECURITY DEFINER (owner postgres): calibragem_listar_casos,
-- calibragem_simular(_ano), calibragem_criticidade_auto, calibragem_recomputar_snapshot.
-- O frontend NÃO usa a view diretamente (0 .from()). Logo revogar o acesso direto
-- não quebra a operação — as RPCs continuam lendo a view como postgres.
-- Não altera Ações Massivas nem outras policies.
-- ============================================================================

-- 1) Remove todo acesso direto de PUBLIC/anon/authenticated (least privilege).
REVOKE ALL ON public.calibragem_saldo_aluno FROM PUBLIC, anon, authenticated;

-- 2) Defesa-em-profundidade: a view passa a obedecer à RLS de quem consulta.
--    As tabelas de origem (acordos_titulos, parcelas, acordos) isolam por dono do
--    aluno; gestão vê global. As RPCs consumidoras são SECURITY DEFINER (postgres)
--    e seguem com visão completa. service_role mantém o acesso já existente.
ALTER VIEW public.calibragem_saldo_aluno SET (security_invoker = true);

-- Remediação de segurança (Supabase Security Advisor / LGPD):
-- converter as 10 views apontadas como "Security Definer View" (lint 0010)
-- para security_invoker=true, de modo que passem a respeitar a RLS e os
-- privilégios do usuário que consulta (authenticated), e não mais os do
-- criador (postgres, que ignora RLS).
--
-- ESCOPO ESTRITO:
--   * Apenas ALTER VIEW ... SET (security_invoker = true).
--   * NÃO altera a definição, colunas, filtros, ordem, nomes ou tipos.
--   * NÃO cria/derruba views, NÃO altera tabelas, RPCs, grants ou frontend.
--   * NÃO amplia SELECT nem concede permissões novas: o modo invoker só pode
--     RESTRINGIR (a RLS passa a valer); nunca concede acesso além das policies
--     das tabelas-base.
--
-- EFEITO POR PERFIL (verificado contra as policies das tabelas-base):
--   * anon / sem cadastro / inativo: NÃO ganham acesso. Nenhuma policy de
--     SELECT das tabelas-base (alunos, acordos_titulos, casos, pagamentos,
--     parcelas, acordos, links_pagamento, operador_atendimentos) tem como alvo
--     o role anon; sob invoker, anon deixa de enxergar linhas (antes o modo
--     definer ignorava a RLS). É uma REDUÇÃO de exposição.
--   * gestão (usuario_e_gestao()/usuario_e_gestao_fila()): resultado idêntico
--     ao atual (policies retornam todas as linhas).
--   * operador: passa a ver exatamente o que as policies das tabelas-base
--     permitem (suas próprias linhas por operador_email / responsável),
--     que é o comportamento pretendido.
--
-- DEPENDÊNCIAS DE FUNÇÃO: caso_saldo_operacional(), usuario_e_gestao(),
--   usuario_e_gestao_fila(), eh_painel(), app_usuario_ativo() são todas
--   SECURITY DEFINER (owner postgres) e NÃO são afetadas pela mudança do modo
--   das views — continuam calculando igual.
--
-- Idempotente: ALTER VIEW ... SET (security_invoker = true) é repetível.
-- Rollback: supabase/rollbacks/20260727170000_revisar_views_security_definer.rollback.sql
--
-- Uso mapeado no frontend (todas via sessão authenticated):
--   consulta_financeira_por_aluno -> 1 arquivo (FinanceiroAluno)
--   vw_fila_links_adm             -> 7 arquivos (fila da gestão/ADM)
--   vw_links_prioridade_operador  -> 8 arquivos (fila do operador)
--   demais 7 views                -> sem uso direto no frontend/edge functions

ALTER VIEW public.consulta_financeira_por_aluno SET (security_invoker = true);
ALTER VIEW public.projecao_operador            SET (security_invoker = true);
ALTER VIEW public.recuperacoes_consolidadas    SET (security_invoker = true);
ALTER VIEW public.vw_alerta_amanda_links_7min  SET (security_invoker = true);
ALTER VIEW public.vw_diagnostico_saldo_casos   SET (security_invoker = true);
ALTER VIEW public.vw_fila_baixa_amanda         SET (security_invoker = true);
ALTER VIEW public.vw_fila_links_adm            SET (security_invoker = true);
ALTER VIEW public.vw_links_prioridade_operador SET (security_invoker = true);
ALTER VIEW public.vw_links_respondidos         SET (security_invoker = true);
ALTER VIEW public.vw_operador_resumo_dia       SET (security_invoker = true);

-- ---------------------------------------------------------------------------
-- Parte 2: remover privilégios inseguros (anon / PUBLIC) das 10 views.
--
-- Auditoria dos GRANTs (information_schema.role_table_grants):
--   * anon: possui TODOS os privilégios (SELECT, INSERT, UPDATE, DELETE,
--     TRUNCATE, REFERENCES, TRIGGER) SOMENTE em vw_diagnostico_saldo_casos.
--     É o único grant a anon entre as 10 views e deve ser removido por
--     completo (sob definer, anon lia 3.891 linhas de saldos/casos).
--   * PUBLIC: nenhum grant encontrado nas 10 views (os REVOKE ... FROM PUBLIC
--     abaixo são defensivos/idempotentes — no-op se nada estiver concedido).
--   * authenticated, service_role, postgres: mantidos intactos.
--
-- Idempotente: REVOKE é repetível (no-op se o privilégio já não existe).
-- ---------------------------------------------------------------------------

-- Obrigatório: revogar SELECT (e todo o resto) de anon em vw_diagnostico_saldo_casos.
REVOKE ALL ON public.vw_diagnostico_saldo_casos FROM anon;

-- Defesa em profundidade: garantir que anon e PUBLIC não tenham privilégio
-- em nenhuma das 10 views (no-op onde já não há grant).
REVOKE ALL ON public.consulta_financeira_por_aluno FROM anon, PUBLIC;
REVOKE ALL ON public.projecao_operador            FROM anon, PUBLIC;
REVOKE ALL ON public.recuperacoes_consolidadas    FROM anon, PUBLIC;
REVOKE ALL ON public.vw_alerta_amanda_links_7min  FROM anon, PUBLIC;
REVOKE ALL ON public.vw_diagnostico_saldo_casos   FROM anon, PUBLIC;
REVOKE ALL ON public.vw_fila_baixa_amanda         FROM anon, PUBLIC;
REVOKE ALL ON public.vw_fila_links_adm            FROM anon, PUBLIC;
REVOKE ALL ON public.vw_links_prioridade_operador FROM anon, PUBLIC;
REVOKE ALL ON public.vw_links_respondidos         FROM anon, PUBLIC;
REVOKE ALL ON public.vw_operador_resumo_dia       FROM anon, PUBLIC;

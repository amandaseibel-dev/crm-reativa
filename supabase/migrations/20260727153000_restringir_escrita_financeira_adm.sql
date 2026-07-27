-- ============================================================================
-- Migration: restringir escrita financeira administrativa
-- Data.......: 2026-07-27
-- Branch.....: security/restringir-escrita-financeira-adm
--
-- ESCOPO (somente estas tabelas):
--   pagamentos, baixas_pagamento, baixas_importadas,
--   fin_contas, fin_extratos_importados, fin_saldos_diarios, fin_transacoes.
--
-- Objetivo: eliminar INSERT/UPDATE/DELETE amplos (USING true / WITH CHECK true)
--   para o papel `authenticated`, preservando os fluxos legítimos atuais.
--
-- Regras:
--   * anon, sem cadastro e inativo: bloqueados (app_usuario_ativo()).
--   * BAIXA, CONFIRMAÇÃO e ESTORNO de pagamento: SOMENTE gestão financeira
--     autorizada = public.usuario_e_gestao() (Amanda, Fernanda/supervisão,
--     Amanda ADM) + ativo. Operador NÃO insere/estorna/altera baixa direta.
--   * O operador apenas envia o comprovante para a Fila de Confirmação
--     (Edge Function + RPCs SECURITY DEFINER), e aguarda a gestão confirmar,
--     rejeitar ou devolver.
--   * importação/conciliação (baixas_importadas, fin_*): gestão financeira.
--   * LEITURA (SELECT) inalterada em todas as tabelas.
--   * service_role/postgres preservados (RLS não forçada; bypassam).
--   * RPCs SECURITY DEFINER auditadas (concluir_baixa_pagamento,
--     devolver_baixa_pagamento, confirmar_baixa_caso, quitar_e_encerrar_caso,
--     enviar_comprovante_para_baixa, projecao_importar_pagamentos,
--     vincular_pagamento_aluno) continuam funcionando (owner=postgres).
--
-- Frontend (mesma branch): FinanceiroAluno.jsx já esconde baixa/estorno para
--   operador (podeGerirFinanceiro == usuario_e_gestao); acrescentados guards
--   explícitos nos handlers de baixa/estorno/quitação/entrada. Envio de
--   comprovante para confirmação preservado (não gatilha baixas_pagamento).
--
-- Idempotente. NÃO aplicar migration/merge/deploy nesta etapa.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. PAGAMENTOS
--    Já está conforme: escrita ALL restrita a usuario_e_gestao(); operador só
--    SELECT do próprio; painel_negado (RESTRICTIVE). Reforço apenas de "ativo"
--    na escrita da gestão (bloqueia gestão inativa), sem ampliar acesso.
-- ----------------------------------------------------------------------------
drop policy if exists pagamentos_amanda_fernanda_all on public.pagamentos;
create policy pagamentos_gestao_all on public.pagamentos
  for all to authenticated
  using (public.app_usuario_ativo() and public.usuario_e_gestao())
  with check (public.app_usuario_ativo() and public.usuario_e_gestao());

-- ----------------------------------------------------------------------------
-- 2. BAIXAS_PAGAMENTO  (REGRA DEFINITIVA)
--    Baixa, confirmação e estorno de pagamento: SOMENTE gestão financeira
--    autorizada = public.usuario_e_gestao() (Amanda, Fernanda/supervisão,
--    Amanda ADM) + usuário ativo.
--    INSERT: somente gestão financeira.
--    UPDATE: somente gestão financeira (inclui estorno/DEVOLVIDA).
--    DELETE: permanece sem policy (bloqueado). SELECT inalterado.
--    O operador NÃO insere/estorna/altera baixa diretamente: ele apenas envia
--    o comprovante para a Fila de Confirmação (Edge Function / RPCs auditadas
--    concluir_baixa_pagamento, confirmar_baixa_caso, enviar_comprovante_para_baixa,
--    devolver_baixa_pagamento — SECURITY DEFINER, preservadas).
-- ----------------------------------------------------------------------------
drop policy if exists baixas_pagamento_insert on public.baixas_pagamento;
create policy baixas_pagamento_insert on public.baixas_pagamento
  for insert to authenticated
  with check (public.app_usuario_ativo() and public.usuario_e_gestao());

drop policy if exists baixas_pagamento_update on public.baixas_pagamento;
create policy baixas_pagamento_update on public.baixas_pagamento
  for update to authenticated
  using (public.app_usuario_ativo() and public.usuario_e_gestao())
  with check (public.app_usuario_ativo() and public.usuario_e_gestao());

-- ----------------------------------------------------------------------------
-- 3. BAIXAS_IMPORTADAS
--    Importação/aprovação/rejeição de quitação por planilha: gestão financeira.
--    SELECT inalterado (leitura).
-- ----------------------------------------------------------------------------
drop policy if exists baixas_importadas_insert_authenticated on public.baixas_importadas;
create policy baixas_importadas_insert_authenticated on public.baixas_importadas
  for insert to authenticated
  with check (public.app_usuario_ativo() and public.usuario_e_gestao());

drop policy if exists baixas_importadas_update_authenticated on public.baixas_importadas;
create policy baixas_importadas_update_authenticated on public.baixas_importadas
  for update to authenticated
  using (public.app_usuario_ativo() and public.usuario_e_gestao())
  with check (public.app_usuario_ativo() and public.usuario_e_gestao());

drop policy if exists baixas_importadas_delete_authenticated on public.baixas_importadas;
create policy baixas_importadas_delete_authenticated on public.baixas_importadas
  for delete to authenticated
  using (public.app_usuario_ativo() and public.usuario_e_gestao());

-- ----------------------------------------------------------------------------
-- 4. FIN_* (contas, extratos, saldos, transações)
--    Módulo financeiro server-side (nenhuma escrita/leitura direta do frontend).
--    Troca a policy FOR ALL (true) por: SELECT aberto a autenticado (leitura
--    inalterada) + INSERT/UPDATE/DELETE restritos à gestão financeira.
-- ----------------------------------------------------------------------------

-- fin_contas
drop policy if exists fin_contas_authenticated_all on public.fin_contas;
create policy fin_contas_select on public.fin_contas
  for select to authenticated using (true);
create policy fin_contas_write_gestao on public.fin_contas
  for all to authenticated
  using (public.app_usuario_ativo() and public.usuario_e_gestao())
  with check (public.app_usuario_ativo() and public.usuario_e_gestao());

-- fin_extratos_importados
drop policy if exists fin_extratos_authenticated_all on public.fin_extratos_importados;
create policy fin_extratos_select on public.fin_extratos_importados
  for select to authenticated using (true);
create policy fin_extratos_write_gestao on public.fin_extratos_importados
  for all to authenticated
  using (public.app_usuario_ativo() and public.usuario_e_gestao())
  with check (public.app_usuario_ativo() and public.usuario_e_gestao());

-- fin_saldos_diarios
drop policy if exists fin_saldos_authenticated_all on public.fin_saldos_diarios;
create policy fin_saldos_select on public.fin_saldos_diarios
  for select to authenticated using (true);
create policy fin_saldos_write_gestao on public.fin_saldos_diarios
  for all to authenticated
  using (public.app_usuario_ativo() and public.usuario_e_gestao())
  with check (public.app_usuario_ativo() and public.usuario_e_gestao());

-- fin_transacoes
drop policy if exists fin_transacoes_authenticated_all on public.fin_transacoes;
create policy fin_transacoes_select on public.fin_transacoes
  for select to authenticated using (true);
create policy fin_transacoes_write_gestao on public.fin_transacoes
  for all to authenticated
  using (public.app_usuario_ativo() and public.usuario_e_gestao())
  with check (public.app_usuario_ativo() and public.usuario_e_gestao());

commit;

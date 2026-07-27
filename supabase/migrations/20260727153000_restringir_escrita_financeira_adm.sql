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
--   * operador: somente ações do PRÓPRIO atendimento (baixa/estorno do próprio
--     aluno em baixas_pagamento) — escopo por titularidade; nunca de terceiro.
--   * confirmação/baixa/estorno administrativos e importação/conciliação:
--     gestão financeira autorizada = public.usuario_e_gestao() + ativo.
--   * "gestão financeira" aqui é usuario_e_gestao() (Amanda gestora, Fernanda,
--     Amanda ADM) — o mesmo controle central já usado em confirmar_baixa_caso.
--   * LEITURA (SELECT) inalterada em todas as tabelas.
--   * service_role/postgres preservados (RLS não forçada; bypassam).
--   * RPCs SECURITY DEFINER auditadas (concluir_baixa_pagamento,
--     devolver_baixa_pagamento, confirmar_baixa_caso, quitar_e_encerrar_caso,
--     projecao_importar_pagamentos, vincular_pagamento_aluno) continuam
--     funcionando (owner=postgres, ignoram RLS).
--
-- NÃO faz parte desta branch: refactor de frontend, RPCs novas, outras tabelas.
--
-- RISCO RESIDUAL (documentado): o operador ainda pode registrar baixa/estorno
--   por escrita direta nos registros do PRÓPRIO atendimento (fluxo atual do
--   FinanceiroAluno). A migração para RPC dedicada dessas ações fica para a
--   branch financeira de mutações. Esta branch elimina a ESCRITA CRUZADA e a
--   escrita ampla por qualquer autenticado.
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
-- 2. BAIXAS_PAGAMENTO
--    INSERT: gestão OU baixa do PRÓPRIO atendimento (o operador carimba-se em
--            baixado_por_email e o aluno é da sua carteira). Bloqueia registrar
--            pagamento para aluno de terceiro.
--    UPDATE: gestão OU baixa cujo vínculo (baixado_por/responsavel_baixa/
--            operador_origem) é o próprio operador. Bloqueia estorno de baixa
--            de terceiro.
--    DELETE: permanece sem policy (bloqueado). SELECT inalterado.
-- ----------------------------------------------------------------------------
drop policy if exists baixas_pagamento_insert on public.baixas_pagamento;
create policy baixas_pagamento_insert on public.baixas_pagamento
  for insert to authenticated
  with check (
    public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or (
        lower(coalesce(baixado_por_email, '')) = public.app_email()
        and exists (
          select 1 from public.alunos a
          where a.id::text = baixas_pagamento.aluno_id
            and lower(coalesce(a.responsavel_atual_email, '')) = public.app_email()
        )
      )
    )
  );

drop policy if exists baixas_pagamento_update on public.baixas_pagamento;
create policy baixas_pagamento_update on public.baixas_pagamento
  for update to authenticated
  using (
    public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or lower(coalesce(baixado_por_email, ''))      = public.app_email()
      or lower(coalesce(responsavel_baixa_email, '')) = public.app_email()
      or lower(coalesce(operador_origem_email, ''))   = public.app_email()
    )
  )
  with check (
    public.app_usuario_ativo()
    and (
      public.usuario_e_gestao()
      or lower(coalesce(baixado_por_email, ''))      = public.app_email()
      or lower(coalesce(responsavel_baixa_email, '')) = public.app_email()
      or lower(coalesce(operador_origem_email, ''))   = public.app_email()
    )
  );

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

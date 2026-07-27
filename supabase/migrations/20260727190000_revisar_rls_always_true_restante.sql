-- ============================================================================
-- Migration: revisar RLS always_true restante — SOMENTE policies de ESCRITA
-- Data.......: 2026-07-27
-- Branch.....: security/revisar-rls-always-true-restante
--
-- ESCOPO: eliminar as policies de ESCRITA (INSERT WITH CHECK true, UPDATE
--   USING/CHECK true, DELETE USING true) para o papel `authenticated` que
--   ainda estavam abertas (advisor: rls_policy_always_true), preservando os
--   fluxos legítimos atuais.
--
-- NÃO faz parte desta branch (fica para etapa posterior):
--   * Policies SELECT always_true (leitura) — NÃO alteradas aqui.
--   * Refactor de frontend.
--
-- PRESERVADO / INTENCIONAL (NÃO alterado):
--   * service_role / postgres — bypassam RLS (RLS não forçada nessas roles).
--   * role interna `reativa_responsavel_executor` (NOLOGIN, só via SET ROLE
--     dentro de RPCs SECURITY DEFINER owner=postgres): policies *_executor com
--     `true` são intencionais — não são alcançáveis por usuário final.
--       - aluno_movimentacoes_insert_executor
--       - alunos_unificados_update_executor
--       - historico_agendamentos_insert_executor
--       - historico_operadores_insert_executor
--       - parcelas_update_executor
--   * painel_negado (RESTRICTIVE, NOT eh_painel()) permanece e é AND-combinado.
--   * Policies de escrita já restritas em etapas anteriores (não tocadas):
--       - parcelas_update (gestão financeira), sugestoes_update
--         (usuario_e_gestao_fila), alunos_unificados UPDATE
--         (operador_atualiza_sua_fila), aluno_movimentacoes UPDATE
--         (NOT eh_painel), notif_update_proprias.
--
-- HELPERS (já existentes em produção):
--   public.app_usuario_ativo()  -> autenticado + cadastrado + ATIVO
--   public.app_email()          -> e-mail do JWT (lower)
--   public.usuario_e_gestao()   -> perfil de gestão autorizado
--   public.app_pode_borderos_importacoes() -> Borderô/Importação SOMENTE Amanda
--
-- PADRÕES DE CORREÇÃO:
--   FLOOR       : app_usuario_ativo()  (bloqueia anon / sem-cadastro / inativo)
--   TITULARIDADE: app_usuario_ativo() AND (usuario_e_gestao()
--                 OR lower(coalesce(<owner>,'')) = app_email() [OR owner vazio])
--   GESTÃO/ADM  : app_usuario_ativo() AND usuario_e_gestao()  (ou Amanda-only)
--
-- Idempotente (drop policy if exists + create). NÃO aplicar / merge / deploy.
-- ============================================================================

begin;

-- ============================================================================
-- TIER A — ADMINISTRATIVO / FINANCEIRO (gestão ou Amanda-only)
-- ============================================================================

-- importacoes — Borderô/Importação: SOMENTE Amanda (regra central).
--   (import de pagamentos/acordos em massa entra por RPC SECURITY DEFINER,
--    que bypassa RLS; frontend Borderos.jsx é operado pela Amanda.)
drop policy if exists importacoes_insert_authenticated on public.importacoes;
create policy importacoes_insert_authenticated on public.importacoes
  for insert to authenticated
  with check (public.app_usuario_ativo() and public.app_pode_borderos_importacoes());

drop policy if exists importacoes_update_authenticated on public.importacoes;
create policy importacoes_update_authenticated on public.importacoes
  for update to authenticated
  using (public.app_usuario_ativo() and public.app_pode_borderos_importacoes())
  with check (public.app_usuario_ativo() and public.app_pode_borderos_importacoes());

-- conferencia_pagamentos — conferência de pagamentos (financeiro).
--   A policy era FOR ALL (true), cobrindo leitura+escrita. Decompõe em:
--     SELECT (true) preserva LEITURA + escrita restrita à gestão.
drop policy if exists authenticated_all_conferencia_pagamentos on public.conferencia_pagamentos;
create policy conferencia_pagamentos_select on public.conferencia_pagamentos
  for select to authenticated using (true);
create policy conferencia_pagamentos_write_gestao on public.conferencia_pagamentos
  for all to authenticated
  using (public.app_usuario_ativo() and public.usuario_e_gestao())
  with check (public.app_usuario_ativo() and public.usuario_e_gestao());

-- ============================================================================
-- TIER B — TITULARIDADE (dono do registro ou gestão)
-- ============================================================================

-- carteira_operador — carteira do próprio operador (ou gestão).
--   Atribuição em massa/assunção de atendimento entra por RPC (definer).
drop policy if exists carteira_insert on public.carteira_operador;
create policy carteira_insert on public.carteira_operador
  for insert to authenticated
  with check (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email,'')) = public.app_email()
      or coalesce(operador_email,'') = ''
    )
  );

drop policy if exists carteira_update on public.carteira_operador;
create policy carteira_update on public.carteira_operador
  for update to authenticated
  using (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email,'')) = public.app_email()
      or coalesce(operador_email,'') = ''
    )
  );

drop policy if exists carteira_delete on public.carteira_operador;
create policy carteira_delete on public.carteira_operador
  for delete to authenticated
  using (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email,'')) = public.app_email()
    )
  );

-- fila_receptivo — presença/estado do próprio operador (email) ou gestão.
drop policy if exists fila_receptivo_insert on public.fila_receptivo;
create policy fila_receptivo_insert on public.fila_receptivo
  for insert to authenticated
  with check (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(email,'')) = public.app_email()
    )
  );

drop policy if exists fila_receptivo_update on public.fila_receptivo;
create policy fila_receptivo_update on public.fila_receptivo
  for update to authenticated
  using (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(email,'')) = public.app_email()
    )
  );

-- ponto_operadores — ponto do próprio operador (email) ou gestão.
drop policy if exists ponto_operadores_insert on public.ponto_operadores;
create policy ponto_operadores_insert on public.ponto_operadores
  for insert to authenticated
  with check (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(email,'')) = public.app_email()
    )
  );

drop policy if exists ponto_operadores_update on public.ponto_operadores;
create policy ponto_operadores_update on public.ponto_operadores
  for update to authenticated
  using (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(email,'')) = public.app_email()
    )
  );

-- solicitacoes_financeiro — solicitação do próprio operador; gestão trata todas.
drop policy if exists solicitacoes_financeiro_insert on public.solicitacoes_financeiro;
create policy solicitacoes_financeiro_insert on public.solicitacoes_financeiro
  for insert to authenticated
  with check (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email,'')) = public.app_email()
    )
  );

drop policy if exists solicitacoes_financeiro_update on public.solicitacoes_financeiro;
create policy solicitacoes_financeiro_update on public.solicitacoes_financeiro
  for update to authenticated
  using (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email,'')) = public.app_email()
    )
  );

-- solicitacoes_link_pagamento — solicitação do próprio operador; gestão/adm trata.
drop policy if exists solicitacoes_link_insert on public.solicitacoes_link_pagamento;
create policy solicitacoes_link_insert on public.solicitacoes_link_pagamento
  for insert to authenticated
  with check (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_solicitante_email,'')) = public.app_email()
    )
  );

drop policy if exists solicitacoes_link_update on public.solicitacoes_link_pagamento;
create policy solicitacoes_link_update on public.solicitacoes_link_pagamento
  for update to authenticated
  using (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_solicitante_email,'')) = public.app_email()
    )
  )
  with check (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_solicitante_email,'')) = public.app_email()
    )
  );

-- termos_acordo — termo do próprio operador; gestão/adm valida.
--   Havia 2 policies INSERT e 2 UPDATE duplicadas (todas true): consolida em 1
--   de cada, hardened. As duplicatas antigas são removidas.
drop policy if exists permitir_insert_termos_acordo on public.termos_acordo;
drop policy if exists termos_acordo_insert_authenticated on public.termos_acordo;
create policy termos_acordo_insert_authenticated on public.termos_acordo
  for insert to authenticated
  with check (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email,'')) = public.app_email()
    )
  );

drop policy if exists permitir_update_termos_acordo on public.termos_acordo;
drop policy if exists termos_acordo_update_authenticated on public.termos_acordo;
create policy termos_acordo_update_authenticated on public.termos_acordo
  for update to authenticated
  using (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email,'')) = public.app_email()
    )
  )
  with check (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email,'')) = public.app_email()
    )
  );

-- links_pagamento — link do próprio operador (operador_email) ou gestão/adm.
--   Gate ÚNICO de escrita da tabela (sem outra policy). operador_email vazio
--   (registros legados/sistema) liberado para não quebrar fluxos existentes.
drop policy if exists links_pagamento_insert_authenticated on public.links_pagamento;
create policy links_pagamento_insert_authenticated on public.links_pagamento
  for insert to authenticated
  with check (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email,'')) = public.app_email()
      or coalesce(operador_email,'') = ''
    )
  );

drop policy if exists links_pagamento_update_authenticated on public.links_pagamento;
create policy links_pagamento_update_authenticated on public.links_pagamento
  for update to authenticated
  using (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email,'')) = public.app_email()
      or coalesce(operador_email,'') = ''
    )
  )
  with check (
    public.app_usuario_ativo() and (
      public.usuario_e_gestao()
      or lower(coalesce(operador_email,'')) = public.app_email()
      or coalesce(operador_email,'') = ''
    )
  );

-- notificacoes — UPDATE always_true é redundante: já existe notif_update_proprias
--   (usuario_destino_email = auth.email()). Remove o always_true e preserva o
--   update das próprias notificações. INSERT continua aberto a usuário ativo
--   (o sistema cria notificação PARA outros destinatários).
drop policy if exists notificacoes_update on public.notificacoes;

drop policy if exists notificacoes_insert on public.notificacoes;
create policy notificacoes_insert on public.notificacoes
  for insert to authenticated
  with check (public.app_usuario_ativo());

-- ============================================================================
-- TIER C — FLOOR (logs/auditoria e caminhos multi-autor):
--   bloqueia anon / sem-cadastro / inativo (app_usuario_ativo()).
--   Titularidade fina adiada (ver RISCOS RESIDUAIS no relatório).
-- ============================================================================

-- acordo_titulo_vinculo (vínculo financeiro; integridade de acordo_id já
--   protegida por trigger fila_acordos_guard_acordo_id).
drop policy if exists atv_insert on public.acordo_titulo_vinculo;
create policy atv_insert on public.acordo_titulo_vinculo
  for insert to authenticated with check (public.app_usuario_ativo());

drop policy if exists atv_update on public.acordo_titulo_vinculo;
create policy atv_update on public.acordo_titulo_vinculo
  for update to authenticated using (public.app_usuario_ativo());

drop policy if exists atv_delete on public.acordo_titulo_vinculo;
create policy atv_delete on public.acordo_titulo_vinculo
  for delete to authenticated using (public.app_usuario_ativo());

-- aluno_movimentacoes (log)
drop policy if exists aluno_movimentacoes_insert on public.aluno_movimentacoes;
create policy aluno_movimentacoes_insert on public.aluno_movimentacoes
  for insert to authenticated with check (public.app_usuario_ativo());

-- alunos_unificados (INSERT; UPDATE já restrito por operador_atualiza_sua_fila)
drop policy if exists alunos_unificados_insert_authenticated on public.alunos_unificados;
create policy alunos_unificados_insert_authenticated on public.alunos_unificados
  for insert to authenticated with check (public.app_usuario_ativo());

-- historico_agendamentos (log)
drop policy if exists historico_agendamentos_insert_authenticated on public.historico_agendamentos;
create policy historico_agendamentos_insert_authenticated on public.historico_agendamentos
  for insert to authenticated with check (public.app_usuario_ativo());

-- historico_alteracoes_crm (log)
drop policy if exists historico_alteracoes_insert_authenticated on public.historico_alteracoes_crm;
create policy historico_alteracoes_insert_authenticated on public.historico_alteracoes_crm
  for insert to authenticated with check (public.app_usuario_ativo());

-- historico_atendimentos (log)
drop policy if exists historico_insert_authenticated on public.historico_atendimentos;
create policy historico_insert_authenticated on public.historico_atendimentos
  for insert to authenticated with check (public.app_usuario_ativo());

-- historico_casos (log)
drop policy if exists historico_casos_insert on public.historico_casos;
create policy historico_casos_insert on public.historico_casos
  for insert to authenticated with check (public.app_usuario_ativo());

-- historico_links_pagamento (log)
drop policy if exists historico_links_insert_authenticated on public.historico_links_pagamento;
create policy historico_links_insert_authenticated on public.historico_links_pagamento
  for insert to authenticated with check (public.app_usuario_ativo());

-- historico_operadores_alunos (log: INSERT + UPDATE)
drop policy if exists historico_operadores_insert_authenticated on public.historico_operadores_alunos;
create policy historico_operadores_insert_authenticated on public.historico_operadores_alunos
  for insert to authenticated with check (public.app_usuario_ativo());

drop policy if exists historico_operadores_update_authenticated on public.historico_operadores_alunos;
create policy historico_operadores_update_authenticated on public.historico_operadores_alunos
  for update to authenticated
  using (public.app_usuario_ativo()) with check (public.app_usuario_ativo());

-- links_pagamento_historico (log)
drop policy if exists links_pagamento_historico_insert on public.links_pagamento_historico;
create policy links_pagamento_historico_insert on public.links_pagamento_historico
  for insert to authenticated with check (public.app_usuario_ativo());

-- sugestoes (INSERT; UPDATE já restrito por usuario_e_gestao_fila)
drop policy if exists sugestoes_insert on public.sugestoes;
create policy sugestoes_insert on public.sugestoes
  for insert to authenticated with check (public.app_usuario_ativo());

-- parcelas (INSERT de parcela de acordo; UPDATE já restrito a gestão financeira
--   por parcelas_update e parcelas_update_executor é intencional).
drop policy if exists parcelas_insert on public.parcelas;
create policy parcelas_insert on public.parcelas
  for insert to authenticated with check (public.app_usuario_ativo());

commit;

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
-- PADRÕES DE CORREÇÃO (app_usuario_ativo() NUNCA é a única restrição):
--   TITULARIDADE: app_usuario_ativo() AND (usuario_e_gestao()
--                 OR lower(coalesce(<owner>,'')) = app_email() [OR owner vazio])
--   GESTÃO/ADM  : app_usuario_ativo() AND usuario_e_gestao()  (ou Amanda-only)
--   LOG (TIER C): INSERT só do PRÓPRIO autor (coluna-autor = app_email() ou
--                 nome via app_matches_nome; vazio=sistema); UPDATE/DELETE bloqueados
--   VÍNCULO/PARCELA: titularidade pelo acordo (app_owns_acordo) ou gestão
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
--   update das próprias notificações.
--   INSERT: frontend NÃO insere direto (só marca como lida); a criação de
--   notificação para terceiros ocorre via RPC/trigger SECURITY DEFINER (bypassa
--   RLS). Restringe INSERT direto de authenticated à gestão (nunca só ativo).
drop policy if exists notificacoes_update on public.notificacoes;

drop policy if exists notificacoes_insert on public.notificacoes;
create policy notificacoes_insert on public.notificacoes
  for insert to authenticated
  with check (public.app_usuario_ativo() and public.usuario_e_gestao());

-- ============================================================================
-- TIER C — TITULARIDADE REAL (app_usuario_ativo() NUNCA é a única restrição)
--   Logs/auditoria: INSERT só do PRÓPRIO autor (ou gestão / RPC interna que
--     bypassa RLS); UPDATE e DELETE bloqueados (sem policy).
--   Vínculos/parcelas: titularidade pelo acordo/aluno relacionado, ou gestão;
--     USING+CHECK impedem trocar acordo_id para escapar do escopo.
-- ----------------------------------------------------------------------------
-- HELPERS desta etapa (SECURITY DEFINER: fazem a checagem de titularidade sem
--   recair na RLS das tabelas relacionadas; leem o e-mail do JWT via app_email).
-- ============================================================================

-- Titularidade de acordo: acordo é do operador (operador_responsavel_email) OU
--   do aluno responsável (responsavel_atual_email). Acordo órfão (ambos vazios)
--   liberado a usuário ativo (legado/sistema) — documentado como residual.
create or replace function public.app_owns_acordo(p_acordo_id uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.acordos a
    left join public.alunos al on al.id = a.aluno_id
    where a.id = p_acordo_id
      and (
        (public.app_email() <> '' and lower(coalesce(a.operador_responsavel_email,'')) = public.app_email())
        or (public.app_email() <> '' and lower(coalesce(al.responsavel_atual_email,'')) = public.app_email())
        or (coalesce(a.operador_responsavel_email,'') = '' and coalesce(al.responsavel_atual_email,'') = '')
      )
  );
$$;

-- Nome do autor (coluna textual) bate com o nome cadastrado do chamador.
--   Vazio/nulo é liberado (inserts que não preenchem o autor); nunca permite
--   atribuir a NOME de outro operador.
create or replace function public.app_matches_nome(p text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p is null or btrim(p) = '' or exists (
    select 1 from public.usuarios u
    where lower(u.email) = public.app_email()
      and lower(btrim(p)) in (lower(coalesce(u.nome,'')), lower(coalesce(u.operador_nome,'')), lower(coalesce(u.operador,'')))
  );
$$;

revoke all on function public.app_owns_acordo(uuid) from public;
revoke all on function public.app_matches_nome(text) from public;
grant execute on function public.app_owns_acordo(uuid) to authenticated, service_role;
grant execute on function public.app_matches_nome(text) to authenticated, service_role;

-- acordo_titulo_vinculo (vínculo financeiro) — titularidade pelo acordo.
--   INSERT/UPDATE/DELETE só do acordo do próprio operador ou gestão. UPDATE
--   valida acordo_id novo e antigo (impede migrar vínculo para acordo de 3º).
--   DELETE = desvínculo, fluxo operacional comprovado (FinanceiroAluno).
drop policy if exists atv_insert on public.acordo_titulo_vinculo;
create policy atv_insert on public.acordo_titulo_vinculo
  for insert to authenticated
  with check (public.app_usuario_ativo() and (public.usuario_e_gestao() or public.app_owns_acordo(acordo_id)));

drop policy if exists atv_update on public.acordo_titulo_vinculo;
create policy atv_update on public.acordo_titulo_vinculo
  for update to authenticated
  using (public.app_usuario_ativo() and (public.usuario_e_gestao() or public.app_owns_acordo(acordo_id)))
  with check (public.app_usuario_ativo() and (public.usuario_e_gestao() or public.app_owns_acordo(acordo_id)));

drop policy if exists atv_delete on public.acordo_titulo_vinculo;
create policy atv_delete on public.acordo_titulo_vinculo
  for delete to authenticated
  using (public.app_usuario_ativo() and (public.usuario_e_gestao() or public.app_owns_acordo(acordo_id)));

-- parcelas (INSERT) — titularidade pelo acordo. UPDATE já restrito a gestão
--   financeira (parcelas_update) e executor (intencional); DELETE sem policy.
drop policy if exists parcelas_insert on public.parcelas;
create policy parcelas_insert on public.parcelas
  for insert to authenticated
  with check (public.app_usuario_ativo() and (public.usuario_e_gestao() or public.app_owns_acordo(acordo_id)));

-- ---- LOGS/AUDITORIA: INSERT só do próprio autor (ou gestão); UPDATE/DELETE bloqueados
-- Coluna-autor = e-mail (vazio liberado para inserts de sistema/RPC; nunca
--   permite atribuir a e-mail de OUTRO operador).

-- aluno_movimentacoes (registrado_por_email)
drop policy if exists aluno_movimentacoes_insert on public.aluno_movimentacoes;
create policy aluno_movimentacoes_insert on public.aluno_movimentacoes
  for insert to authenticated
  with check (public.app_usuario_ativo() and (public.usuario_e_gestao()
    or coalesce(registrado_por_email,'') = '' or lower(registrado_por_email) = public.app_email()));

-- alunos_unificados (operador_email) — frontend não faz INSERT (só RPC/UPDATE
--   próprio via operador_atualiza_sua_fila); restringe por titularidade.
drop policy if exists alunos_unificados_insert_authenticated on public.alunos_unificados;
create policy alunos_unificados_insert_authenticated on public.alunos_unificados
  for insert to authenticated
  with check (public.app_usuario_ativo() and (public.usuario_e_gestao()
    or coalesce(operador_email,'') = '' or lower(operador_email) = public.app_email()));

-- historico_agendamentos (operador_email) — só RPC no frontend
drop policy if exists historico_agendamentos_insert_authenticated on public.historico_agendamentos;
create policy historico_agendamentos_insert_authenticated on public.historico_agendamentos
  for insert to authenticated
  with check (public.app_usuario_ativo() and (public.usuario_e_gestao()
    or coalesce(operador_email,'') = '' or lower(operador_email) = public.app_email()));

-- historico_alteracoes_crm (usuario_email)
drop policy if exists historico_alteracoes_insert_authenticated on public.historico_alteracoes_crm;
create policy historico_alteracoes_insert_authenticated on public.historico_alteracoes_crm
  for insert to authenticated
  with check (public.app_usuario_ativo() and (public.usuario_e_gestao()
    or coalesce(usuario_email,'') = '' or lower(usuario_email) = public.app_email()));

-- historico_atendimentos (operador = NOME) — casa com o nome do chamador
drop policy if exists historico_insert_authenticated on public.historico_atendimentos;
create policy historico_insert_authenticated on public.historico_atendimentos
  for insert to authenticated
  with check (public.app_usuario_ativo() and (public.usuario_e_gestao() or public.app_matches_nome(operador)));

-- historico_casos (operador = NOME)
drop policy if exists historico_casos_insert on public.historico_casos;
create policy historico_casos_insert on public.historico_casos
  for insert to authenticated
  with check (public.app_usuario_ativo() and (public.usuario_e_gestao() or public.app_matches_nome(operador)));

-- historico_links_pagamento (usuario_email)
drop policy if exists historico_links_insert_authenticated on public.historico_links_pagamento;
create policy historico_links_insert_authenticated on public.historico_links_pagamento
  for insert to authenticated
  with check (public.app_usuario_ativo() and (public.usuario_e_gestao()
    or coalesce(usuario_email,'') = '' or lower(usuario_email) = public.app_email()));

-- historico_operadores_alunos (operador_email) — INSERT próprio; UPDATE BLOQUEADO
drop policy if exists historico_operadores_insert_authenticated on public.historico_operadores_alunos;
create policy historico_operadores_insert_authenticated on public.historico_operadores_alunos
  for insert to authenticated
  with check (public.app_usuario_ativo() and (public.usuario_e_gestao()
    or coalesce(operador_email,'') = '' or lower(operador_email) = public.app_email()));
-- UPDATE de log removido (bloqueado). Frontend não faz UPDATE direto; RPCs
--   (SECURITY DEFINER, owner=postgres) bypassam RLS e seguem funcionando.
drop policy if exists historico_operadores_update_authenticated on public.historico_operadores_alunos;

-- links_pagamento_historico (usuario = e-mail)
drop policy if exists links_pagamento_historico_insert on public.links_pagamento_historico;
create policy links_pagamento_historico_insert on public.links_pagamento_historico
  for insert to authenticated
  with check (public.app_usuario_ativo() and (public.usuario_e_gestao()
    or coalesce(usuario,'') = '' or lower(usuario) = public.app_email()));

-- sugestoes (autor_email) — cada um envia a PRÓPRIA sugestão
drop policy if exists sugestoes_insert on public.sugestoes;
create policy sugestoes_insert on public.sugestoes
  for insert to authenticated
  with check (public.app_usuario_ativo() and (public.usuario_e_gestao()
    or coalesce(autor_email,'') = '' or lower(autor_email) = public.app_email()));

commit;

-- ============================================================================
-- ROLLBACK: revisar RLS always_true restante (policies de ESCRITA)
-- Branch.....: security/revisar-rls-always-true-restante
--
-- Restaura EXATAMENTE o estado anterior (always_true) de cada policy de
-- escrita alterada, incluindo nomes de policies duplicadas/decompostas.
-- Idempotente. Não toca em service_role/postgres nem na role executor.
-- ============================================================================

begin;

-- ---- TIER A -----------------------------------------------------------------

drop policy if exists importacoes_insert_authenticated on public.importacoes;
create policy importacoes_insert_authenticated on public.importacoes
  for insert to authenticated with check (true);

drop policy if exists importacoes_update_authenticated on public.importacoes;
create policy importacoes_update_authenticated on public.importacoes
  for update to authenticated using (true) with check (true);

-- conferencia_pagamentos: volta à policy FOR ALL (true) única.
drop policy if exists conferencia_pagamentos_select on public.conferencia_pagamentos;
drop policy if exists conferencia_pagamentos_write_gestao on public.conferencia_pagamentos;
create policy authenticated_all_conferencia_pagamentos on public.conferencia_pagamentos
  for all to authenticated using (true) with check (true);

-- ---- TIER B -----------------------------------------------------------------

drop policy if exists carteira_insert on public.carteira_operador;
create policy carteira_insert on public.carteira_operador
  for insert to authenticated with check (true);
drop policy if exists carteira_update on public.carteira_operador;
create policy carteira_update on public.carteira_operador
  for update to authenticated using (true);
drop policy if exists carteira_delete on public.carteira_operador;
create policy carteira_delete on public.carteira_operador
  for delete to authenticated using (true);

drop policy if exists fila_receptivo_insert on public.fila_receptivo;
create policy fila_receptivo_insert on public.fila_receptivo
  for insert to authenticated with check (true);
drop policy if exists fila_receptivo_update on public.fila_receptivo;
create policy fila_receptivo_update on public.fila_receptivo
  for update to authenticated using (true);

drop policy if exists ponto_operadores_insert on public.ponto_operadores;
create policy ponto_operadores_insert on public.ponto_operadores
  for insert to authenticated with check (true);
drop policy if exists ponto_operadores_update on public.ponto_operadores;
create policy ponto_operadores_update on public.ponto_operadores
  for update to authenticated using (true);

drop policy if exists solicitacoes_financeiro_insert on public.solicitacoes_financeiro;
create policy solicitacoes_financeiro_insert on public.solicitacoes_financeiro
  for insert to authenticated with check (true);
drop policy if exists solicitacoes_financeiro_update on public.solicitacoes_financeiro;
create policy solicitacoes_financeiro_update on public.solicitacoes_financeiro
  for update to authenticated using (true);

drop policy if exists solicitacoes_link_insert on public.solicitacoes_link_pagamento;
create policy solicitacoes_link_insert on public.solicitacoes_link_pagamento
  for insert to authenticated with check (true);
drop policy if exists solicitacoes_link_update on public.solicitacoes_link_pagamento;
create policy solicitacoes_link_update on public.solicitacoes_link_pagamento
  for update to authenticated using (true) with check (true);

-- termos_acordo: restaura as 2 INSERT e 2 UPDATE duplicadas (todas true).
drop policy if exists termos_acordo_insert_authenticated on public.termos_acordo;
create policy termos_acordo_insert_authenticated on public.termos_acordo
  for insert to authenticated with check (true);
create policy permitir_insert_termos_acordo on public.termos_acordo
  for insert to authenticated with check (true);
drop policy if exists termos_acordo_update_authenticated on public.termos_acordo;
create policy termos_acordo_update_authenticated on public.termos_acordo
  for update to authenticated using (true) with check (true);
create policy permitir_update_termos_acordo on public.termos_acordo
  for update to authenticated using (true) with check (true);

drop policy if exists links_pagamento_insert_authenticated on public.links_pagamento;
create policy links_pagamento_insert_authenticated on public.links_pagamento
  for insert to authenticated with check (true);
drop policy if exists links_pagamento_update_authenticated on public.links_pagamento;
create policy links_pagamento_update_authenticated on public.links_pagamento
  for update to authenticated using (true) with check (true);

-- notificacoes: recria o UPDATE always_true removido; restaura INSERT true.
drop policy if exists notificacoes_update on public.notificacoes;
create policy notificacoes_update on public.notificacoes
  for update to authenticated using (true) with check (true);
drop policy if exists notificacoes_insert on public.notificacoes;
create policy notificacoes_insert on public.notificacoes
  for insert to authenticated with check (true);

-- ---- TIER C -----------------------------------------------------------------

drop policy if exists atv_insert on public.acordo_titulo_vinculo;
create policy atv_insert on public.acordo_titulo_vinculo
  for insert to authenticated with check (true);
drop policy if exists atv_update on public.acordo_titulo_vinculo;
create policy atv_update on public.acordo_titulo_vinculo
  for update to authenticated using (true);
drop policy if exists atv_delete on public.acordo_titulo_vinculo;
create policy atv_delete on public.acordo_titulo_vinculo
  for delete to authenticated using (true);

drop policy if exists aluno_movimentacoes_insert on public.aluno_movimentacoes;
create policy aluno_movimentacoes_insert on public.aluno_movimentacoes
  for insert to authenticated with check (true);

drop policy if exists alunos_unificados_insert_authenticated on public.alunos_unificados;
create policy alunos_unificados_insert_authenticated on public.alunos_unificados
  for insert to authenticated with check (true);

drop policy if exists historico_agendamentos_insert_authenticated on public.historico_agendamentos;
create policy historico_agendamentos_insert_authenticated on public.historico_agendamentos
  for insert to authenticated with check (true);

drop policy if exists historico_alteracoes_insert_authenticated on public.historico_alteracoes_crm;
create policy historico_alteracoes_insert_authenticated on public.historico_alteracoes_crm
  for insert to authenticated with check (true);

drop policy if exists historico_insert_authenticated on public.historico_atendimentos;
create policy historico_insert_authenticated on public.historico_atendimentos
  for insert to authenticated with check (true);

drop policy if exists historico_casos_insert on public.historico_casos;
create policy historico_casos_insert on public.historico_casos
  for insert to authenticated with check (true);

drop policy if exists historico_links_insert_authenticated on public.historico_links_pagamento;
create policy historico_links_insert_authenticated on public.historico_links_pagamento
  for insert to authenticated with check (true);

drop policy if exists historico_operadores_insert_authenticated on public.historico_operadores_alunos;
create policy historico_operadores_insert_authenticated on public.historico_operadores_alunos
  for insert to authenticated with check (true);
drop policy if exists historico_operadores_update_authenticated on public.historico_operadores_alunos;
create policy historico_operadores_update_authenticated on public.historico_operadores_alunos
  for update to authenticated using (true) with check (true);

drop policy if exists links_pagamento_historico_insert on public.links_pagamento_historico;
create policy links_pagamento_historico_insert on public.links_pagamento_historico
  for insert to authenticated with check (true);

drop policy if exists sugestoes_insert on public.sugestoes;
create policy sugestoes_insert on public.sugestoes
  for insert to authenticated with check (true);

drop policy if exists parcelas_insert on public.parcelas;
create policy parcelas_insert on public.parcelas
  for insert to authenticated with check (true);

-- Helpers de titularidade TIER C criados na migration.
drop function if exists public.app_owns_acordo(uuid);
drop function if exists public.app_matches_nome(text);

commit;

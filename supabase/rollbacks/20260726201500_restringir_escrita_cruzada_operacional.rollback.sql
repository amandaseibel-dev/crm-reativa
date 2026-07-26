-- ============================================================================
-- ROLLBACK de 20260726201500_restringir_escrita_cruzada_operacional
-- ============================================================================
-- ATENÇÃO / EMERGÊNCIA:
--   Este script RESTAURA as permissões AMPLAS anteriores, reabrindo a escrita
--   cruzada em alunos/casos/acordos/acordos_titulos (USING true / WITH CHECK
--   true) e removendo o guard de colunas sensíveis de alunos.
--   Use SOMENTE em emergência (regressão operacional grave) e reverta o quanto
--   antes. Restaura policies e o guard-trigger novo é removido.
--   Não altera grants (não foram modificados pela migration) nem os guards
--   pré-existentes (_guard_resp_aluno, _guard_resp_acordo,
--   bloquear_alteracoes_restritas_casos), que já existiam antes.
-- ============================================================================

begin;

-- ---- ACORDOS_TITULOS: volta a USING true / WITH CHECK true ------------------
drop policy if exists acordos_titulos_insert_authenticated on public.acordos_titulos;
create policy acordos_titulos_insert_authenticated on public.acordos_titulos
  for insert to authenticated
  with check (true);

drop policy if exists acordos_titulos_update_authenticated on public.acordos_titulos;
create policy acordos_titulos_update_authenticated on public.acordos_titulos
  for update to authenticated
  using (true)
  with check (true);

-- ---- ACORDOS: volta a WITH CHECK true (insert) e USING true (update) --------
drop policy if exists acordos_insert on public.acordos;
create policy acordos_insert on public.acordos
  for insert to authenticated
  with check (true);

drop policy if exists acordos_update on public.acordos;
create policy acordos_update on public.acordos
  for update to authenticated
  using (true);

-- ---- CASOS: volta a USING true / WITH CHECK true e DELETE aberto ------------
drop policy if exists casos_insert_todos on public.casos;
create policy casos_insert_todos on public.casos
  for insert to authenticated
  with check (true);

drop policy if exists casos_update_todos on public.casos;
create policy casos_update_todos on public.casos
  for update to authenticated
  using (true)
  with check (true);

drop policy if exists casos_delete_gestao on public.casos;
create policy casos_delete_todos on public.casos
  for delete to authenticated
  using (true);

-- ---- ALUNOS: remove guard novo e volta INSERT/UPDATE amplos ----------------
drop trigger if exists trg_guard_cols_aluno on public.alunos;
drop function if exists public._guard_cols_aluno();

drop policy if exists alunos_insert on public.alunos;
create policy "Enable insert for authenticated users only" on public.alunos
  for insert to authenticated
  with check (true);

drop policy if exists alunos_update on public.alunos;
create policy alunos_update on public.alunos
  for update to authenticated
  using (not eh_painel());

-- ---- HELPERS: remover (nenhuma outra dependência fora desta migration) ------
-- Se algo ainda referenciar, o DROP falha e mantém o helper (seguro).
drop function if exists public.app_usuario_ativo();
drop function if exists public.app_email();

commit;

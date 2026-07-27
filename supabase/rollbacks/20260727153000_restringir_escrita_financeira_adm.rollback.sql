-- ============================================================================
-- ROLLBACK de 20260727153000_restringir_escrita_financeira_adm
-- ============================================================================
-- ATENÇÃO / EMERGÊNCIA:
--   Este script REABRE a escrita financeira ampla para qualquer `authenticated`
--   (INSERT/UPDATE/DELETE com USING true / WITH CHECK true) em baixas_pagamento,
--   baixas_importadas e nas tabelas fin_*, e volta pagamentos ao gate sem a
--   exigência de "ativo". Reabre escrita cruzada financeira. Usar SOMENTE em
--   emergência e reverter o quanto antes. Não altera grants nem RPCs.
-- ============================================================================

begin;

-- ---- FIN_* : volta a FOR ALL (true) ----
drop policy if exists fin_transacoes_select on public.fin_transacoes;
drop policy if exists fin_transacoes_write_gestao on public.fin_transacoes;
create policy fin_transacoes_authenticated_all on public.fin_transacoes
  for all to authenticated using (true) with check (true);

drop policy if exists fin_saldos_select on public.fin_saldos_diarios;
drop policy if exists fin_saldos_write_gestao on public.fin_saldos_diarios;
create policy fin_saldos_authenticated_all on public.fin_saldos_diarios
  for all to authenticated using (true) with check (true);

drop policy if exists fin_extratos_select on public.fin_extratos_importados;
drop policy if exists fin_extratos_write_gestao on public.fin_extratos_importados;
create policy fin_extratos_authenticated_all on public.fin_extratos_importados
  for all to authenticated using (true) with check (true);

drop policy if exists fin_contas_select on public.fin_contas;
drop policy if exists fin_contas_write_gestao on public.fin_contas;
create policy fin_contas_authenticated_all on public.fin_contas
  for all to authenticated using (true) with check (true);

-- ---- BAIXAS_IMPORTADAS ----
drop policy if exists baixas_importadas_insert_authenticated on public.baixas_importadas;
create policy baixas_importadas_insert_authenticated on public.baixas_importadas
  for insert to authenticated with check (true);
drop policy if exists baixas_importadas_update_authenticated on public.baixas_importadas;
create policy baixas_importadas_update_authenticated on public.baixas_importadas
  for update to authenticated using (true) with check (true);
drop policy if exists baixas_importadas_delete_authenticated on public.baixas_importadas;
create policy baixas_importadas_delete_authenticated on public.baixas_importadas
  for delete to authenticated using (true);

-- ---- BAIXAS_PAGAMENTO ----
drop policy if exists baixas_pagamento_insert on public.baixas_pagamento;
create policy baixas_pagamento_insert on public.baixas_pagamento
  for insert to authenticated with check (true);
drop policy if exists baixas_pagamento_update on public.baixas_pagamento;
create policy baixas_pagamento_update on public.baixas_pagamento
  for update to authenticated using (true) with check (true);

-- ---- PAGAMENTOS : volta ao gate original (usuario_e_gestao, sem "ativo") ----
drop policy if exists pagamentos_gestao_all on public.pagamentos;
create policy pagamentos_amanda_fernanda_all on public.pagamentos
  for all to authenticated
  using (usuario_e_gestao())
  with check (usuario_e_gestao());

commit;

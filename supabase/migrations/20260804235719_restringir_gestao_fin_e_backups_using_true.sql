-- ============================================================================
-- Extensão do Bloco 3 — remove SELECT USING(true) em tabelas financeiras e de
-- backup (0 uso no frontend; acesso só por backend/RPC/gestão). Restringe a
-- gestão: financeiro da empresa (fin_*) e backups de PII não devem ser legíveis
-- por operador. Reduz USING(true) restantes de 24 → 15 (os 15 remanescentes são
-- baixa sensibilidade — avisos/email_templates/calibragem_flags/tv_* — ou
-- históricos com uso no frontend a mapear por tela numa próxima rodada).
-- ============================================================================
do $$
declare r record;
begin
  for r in select unnest(array[
    'fin_contas','fin_extratos_importados','fin_saldos_diarios','fin_transacoes',
    'alunos_dedup_backup_20260710','alunos_dedup_conflitos_20260710','alunos_dedup_log_20260710',
    'casos_backup_20260710','pagamentos_duplicados_removidos_20260707']) as tbl
  loop
    execute format('drop policy if exists %I on public.%I',
      case r.tbl
        when 'fin_contas' then 'fin_contas_select'
        when 'fin_extratos_importados' then 'fin_extratos_select'
        when 'fin_saldos_diarios' then 'fin_saldos_select'
        when 'fin_transacoes' then 'fin_transacoes_select'
        when 'alunos_dedup_backup_20260710' then 'backup_dedup_1_select'
        when 'alunos_dedup_conflitos_20260710' then 'backup_dedup_2_select'
        when 'alunos_dedup_log_20260710' then 'backup_dedup_3_select'
        when 'casos_backup_20260710' then 'backup_casos_select'
        when 'pagamentos_duplicados_removidos_20260707' then 'backup_pagtos_dup_select'
      end, r.tbl);
    execute format('create policy %I on public.%I for select to authenticated using (app_usuario_ativo() and usuario_e_gestao())',
      r.tbl||'_select_gestao', r.tbl);
  end loop;
end $$;

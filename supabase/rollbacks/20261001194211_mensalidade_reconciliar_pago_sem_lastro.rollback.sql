-- ============================================================================
-- ROLLBACK de 20261001194211 -- remove a rotina de saneamento do lote G2.
-- ============================================================================
-- Remover a rotina NAO desfaz nenhuma execucao dela. Para reverter um lote JA
-- EXECUTADO use o backup logico, nunca este arquivo:
--
--   update public.acordos_titulos t
--      set situacao = b.situacao, status = b.status, acordo_id = b.acordo_id,
--          origem_liquidacao = b.origem_liquidacao,
--          origem_liquidacao_ref = b.origem_liquidacao_ref,
--          origem_liquidacao_em = b.origem_liquidacao_em,
--          motivo_ajuste = b.motivo_ajuste,
--          atualizado_em = now()
--     from public._backup_pago_sem_lastro_20261001 b
--    where t.id = b.id;
--
-- Reversao por ID EXATO, nunca por criterio: nao ha PITR neste projeto e o
-- criterio pode ter passado a casar linhas que entraram depois. O backup guarda
-- a linha inteira, entao a reversao e campo a campo.
--
-- O par de colunas tem de voltar JUNTO (situacao + status no mesmo update),
-- senao _titulo_situacao_e_status_coerentes coage o resultado em silencio.
-- ============================================================================

begin;

drop function if exists public.mensalidade_reconciliar_pago_sem_lastro(boolean);

commit;

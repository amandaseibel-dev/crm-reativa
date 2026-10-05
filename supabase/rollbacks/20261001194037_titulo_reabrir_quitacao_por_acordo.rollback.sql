-- ============================================================================
-- ROLLBACK de 20261001194037 -- remove a porta explicita.
-- ============================================================================
-- Sem ela nao existe caminho nenhum para tirar um titulo de PAGO/quitada: o
-- motor trata PAGO como terminal. Nada do que ela ja fez e desfeito -- o
-- historico fica em mensalidade_reconciliacao_log (lote
-- REABRIR_QUITACAO_POR_ACORDO) e em motivo_ajuste.
--
-- A rotina de saneamento (etapa 4) CHAMA esta funcao. Derrubar esta sem
-- derrubar aquela deixa a rotina quebrada em tempo de execucao -- rode o
-- rollback da etapa 4 primeiro.
-- ============================================================================

begin;

drop function if exists public.titulo_reabrir_quitacao_por_acordo(uuid);

commit;

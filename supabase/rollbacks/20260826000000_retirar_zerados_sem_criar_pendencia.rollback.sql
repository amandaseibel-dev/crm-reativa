-- Rollback de 20260826000000_retirar_zerados_sem_criar_pendencia.sql
-- Remove a rotina. Os casos já marcados como SEM_SALDO_EM_ABERTO NÃO voltam
-- para as filas: eles não têm dívida, e devolvê-los seria recriar o retrabalho.
drop function if exists public.retirar_zerados_da_operacao(uuid, integer, boolean);

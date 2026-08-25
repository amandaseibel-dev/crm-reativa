-- Rollback de 20260825190000_fila_acordos_sair_sem_saldo.sql
-- Devolve os casos encerrados para "A confirmar" e remove a função.
update public.fila_acordos_confirmar
   set status_confirmacao = 'A_CONFIRMAR',
       confirmado_em      = null
 where status_confirmacao = 'ENCERRADO_SEM_SALDO';

drop function if exists public.fila_acordos_sair_sem_saldo(boolean, int);

-- ROLLBACK da 20261110150000_ulbra_avisos_operador: remove só a função. Não altera dados.
drop function if exists public.ulbra_avisos_operador(integer);

-- ROLLBACK da 20261111120000: remove a função. Não altera dados nem outras funções.
drop function if exists public.ulbra_central_conversas(timestamptz, text, integer, integer);

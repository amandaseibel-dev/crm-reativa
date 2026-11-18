-- ROLLBACK de 20261117100000_carteira_prioridade_bordero.sql
-- Remove apenas a função de leitura. Não toca dado nem outra função.
-- Sem a função, o cliente não revalida: o guiado fica fechado (fail-closed).
drop function if exists public.carteira_prioridade_bordero(uuid[]);

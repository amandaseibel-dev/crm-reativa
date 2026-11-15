-- ROLLBACK da 20261110100000_ulbra_historico_orcamento
drop function if exists public.ulbra_historico_reservar(text, date, integer, integer, integer);
drop table if exists public.ulbra_historico_uso;

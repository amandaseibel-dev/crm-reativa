-- ROLLBACK da 20261111140000: remove as quatro tabelas desta migration.
-- Só usar se ainda não houver envio real. Não toca em nada fora delas.
-- A ordem importa: ulbra_envios referencia ulbra_envio_previas.
drop table if exists public.ulbra_envios;
drop table if exists public.ulbra_envio_previas;
drop table if exists public.ulbra_conexoes_operador;
drop table if exists public.ulbra_conexoes_pedidos;

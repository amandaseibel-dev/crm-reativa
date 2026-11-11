-- ROLLBACK da 20261111140000: remove as três tabelas (só se vazias de uso real). Não toca em nada mais.
drop table if exists public.ulbra_envios;
drop table if exists public.ulbra_conexoes_operador;
drop table if exists public.ulbra_conexoes_pedidos;

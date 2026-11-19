-- ROLLBACK da 20261109170000_ulbra_conexao_e_envio.
-- Remove as tabelas criadas. Antes de rodar, confirme que nenhuma função
-- publicada ainda grava nelas: o envio exige a função de servidor parada.
drop table if exists public.ulbra_envios;
drop table if exists public.ulbra_conexoes_operador;

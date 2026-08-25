-- Rollback de 20260826060000_saude_carteira_movimento_periodo.sql
--
-- Remove as duas funções. Nada de dado é alterado -- as duas só LEEM.
-- A tela perde o painel "Movimento do período"; o componente trata a falha da
-- RPC exibindo a mensagem de erro, então não quebra a página.
--
-- Reverter significa voltar a ler a carteira só pelo estoque -- e o estoque
-- esconde as três coisas que se somam nele: o que foi liquidado, o que entrou
-- por remessa e o que só mudou de prateleira.

drop function if exists public.saude_carteira_movimento_periodo(date, date, jsonb);
drop function if exists public.saude_carteira_movimento(uuid[], date, date);

-- Remove os acordos vivos por operador. A tela /acordos-operador deixa de
-- carregar -- retirar a rota, o guard e o item de menu do App.jsx junto, senão
-- ela abre e mostra só o erro de função inexistente.
--
-- Seguro de rodar: as duas funções só leem. Nada de dado foi criado por elas.
drop function if exists public.carteira_acordos_detalhe(text, text, int, int);
drop function if exists public.carteira_acordos_por_operador();

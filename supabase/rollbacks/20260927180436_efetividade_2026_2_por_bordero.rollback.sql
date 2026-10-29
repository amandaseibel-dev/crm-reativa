-- ROLLBACK de 20260927180436_efetividade_2026_2_por_bordero.sql
--
-- A migration só CRIA três funções de leitura com nomes novos. Não altera
-- nenhuma função existente, nenhuma tabela, nenhuma linha e nenhum gatilho.
-- Reverter é, literalmente, apagar as três.
--
-- AVISA: a tela publicada chama `carteira_2026_2_borderos` e
-- `carteira_2026_2_bordero_detalhe`. Reverter só o banco deixa a aba
-- "Por borderô" da Efetividade 2026/2 recebendo 42883 (função inexistente) e
-- mostrando o erro na tela. A visão "Consolidado", o restante da Efetividade e
-- todo o resto do sistema continuam intactos, porque nada fora destas três
-- funções foi tocado. Só faz sentido reverter junto com o front.
--
-- Não há dado a restaurar: zero escrita.

drop function if exists public.carteira_2026_2_bordero_detalhe(uuid, text, integer, integer);
drop function if exists public.carteira_2026_2_borderos();
drop function if exists public.carteira_2026_2_bordero_classificar();

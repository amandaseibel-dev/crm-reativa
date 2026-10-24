-- ROLLBACK de 20261020183000_central_financeira_dois_indicadores.sql
--
-- A migration cria DUAS VIEWS e nada mais -- nenhum dado, coluna, gatilho ou
-- funcao. Derrubar as duas devolve o banco ao estado anterior, sem perda:
-- nenhuma linha vive nelas.
--
-- Ordem importa: a view de excecoes le a de indicadores.
--
-- Nenhum consumidor no banco depende destas views (nenhuma funcao, view ou
-- gatilho as referencia). O unico consumidor e a aba somente leitura da
-- Central Financeira no frontend, que passa a mostrar o erro de leitura --
-- nada escreve, nada quebra em producao.

DROP VIEW IF EXISTS public.vw_central_financeira_pagamento_excecoes;
DROP VIEW IF EXISTS public.vw_central_financeira_pagamento_indicadores;

-- ROLLBACK de 20261019160000_retorno_prioritario_comentario_da_coluna.
--
-- Devolve o estado anterior EXATO: em 19/10/2026, antes da migration,
-- col_description de public.alunos.retorno_prioritario era NULL -- o comentario
-- nunca havia sido gravado em producao. Logo o rollback apaga o comentario, e nao
-- "restaura um texto antigo", porque texto antigo nao existia.
--
-- Nao toca na coluna, no tipo, no default, nos dados nem em qualquer logica.

comment on column public.alunos.retorno_prioritario is null;

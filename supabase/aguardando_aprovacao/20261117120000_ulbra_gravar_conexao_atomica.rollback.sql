-- ROLLBACK da 20261117120000 (somente a função criada por ela; a tabela pertence à 20261111140000).
-- NÃO EXECUTAR SEM APROVAÇÃO. Sem a função, a aplicação não consegue gravar conexões (fail-closed).
drop function if exists public.ulbra_gravar_conexao(text, text, text, timestamptz, text, text, jsonb, boolean);

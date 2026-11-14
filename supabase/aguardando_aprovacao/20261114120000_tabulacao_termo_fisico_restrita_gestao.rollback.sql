BEGIN;
-- Rollback de 20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.
-- Remove a trigger e a função. Desativa (não apaga) as duas tabulações, como o
-- catálogo manda ("excluir = desativar"): o histórico continua referenciando os códigos.
drop trigger if exists aluno_mov_tabulacao_so_gestao on public.aluno_movimentacoes;
drop function if exists public.aluno_movimentacao_tabulacao_so_gestao();

update public.tabulacoes
   set ativa = false,
       desativada_em = now(),
       desativada_por = 'rollback_termo_fisico'
 where codigo in ('TERMO_FISICO_EM_ANDAMENTO', 'TERMO_FISICO_ARQUIVADO')
   and criado_por = 'migration_termo_fisico';

COMMIT;

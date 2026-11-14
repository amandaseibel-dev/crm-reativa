-- Rollback BEM-SUCEDIDO (banco sem histórico dos códigos). Restaura o estado anterior:
-- as linhas somem, a trigger e a função somem.
\set ON_ERROR_STOP on
select public.teste_assert('rollback limpo: linhas do catálogo removidas (estado anterior)',
  (select count(*) from public.tabulacoes where codigo like 'TERMO_FISICO_%') = 0);
select public.teste_assert('rollback limpo: trigger removida',
  not exists (select 1 from pg_trigger where tgname = 'aluno_mov_tabulacao_so_gestao' and not tgisinternal));
select public.teste_assert('rollback limpo: função removida',
  to_regprocedure('public.aluno_movimentacao_tabulacao_so_gestao()') is null);
select public.teste_assert('rollback limpo: linhas de outras tabulações intactas',
  (select count(*) from public.tabulacoes where codigo = 'CONTATAR') = 1);

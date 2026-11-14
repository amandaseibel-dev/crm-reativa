-- Depois do rollback: trigger removida; catálogo desativado, não apagado;
-- histórico existente preservado.
\set ON_ERROR_STOP on

select public.teste_assert('rollback: trigger removida',
  not exists (select 1 from pg_trigger where tgname = 'aluno_mov_tabulacao_so_gestao' and not tgisinternal));

select public.teste_assert('rollback: linhas do catálogo continuam existindo, desativadas',
  (select count(*) from public.tabulacoes where codigo like 'TERMO_FISICO_%' and not ativa) = 2);

select public.teste_assert('rollback: histórico registrado antes continua existindo',
  (select count(*) from public.aluno_movimentacoes where status_novo like 'TERMO_FISICO_%') >= 2);

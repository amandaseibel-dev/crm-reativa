-- Rollback RECUSADO (há histórico usando os códigos). Roda depois do rollback, que deve falhar.
-- Garante que nada foi removido nem alterado.
\set ON_ERROR_STOP on
select public.teste_assert('rollback recusado: as duas linhas do catálogo continuam ativas e restritas',
  (select count(*) from public.tabulacoes where codigo in ('TERMO_FISICO_EM_ANDAMENTO','TERMO_FISICO_ARQUIVADO')
     and ativa and somente_gestao) = 2);
select public.teste_assert('rollback recusado: a trigger continua instalada',
  exists (select 1 from pg_trigger where tgname = 'aluno_mov_tabulacao_so_gestao' and not tgisinternal));
select public.teste_assert('rollback recusado: histórico preservado',
  (select count(*) from public.aluno_movimentacoes where status_novo like 'TERMO_FISICO_%') >= 2);

-- Rollback recusado por decisão (opção A): nada removido; barreira de estado e de histórico intactas.
\set ON_ERROR_STOP on
select public.teste_assert('rollback: linhas do catálogo permanecem (barreira de estado depende delas)',
  (select count(*) from public.tabulacoes where codigo in ('TERMO_FISICO_EM_ANDAMENTO','TERMO_FISICO_ARQUIVADO') and somente_gestao) = 2);
select public.teste_assert('rollback: trigger de histórico permanece',
  exists (select 1 from pg_trigger where tgname = 'aluno_mov_tabulacao_so_gestao' and not tgisinternal));
select public.teste_assert('rollback: outras tabulações intactas',
  (select count(*) from public.tabulacoes where codigo = 'CONTATAR') = 1);

-- Depois do rollback REVERSÍVEL em banco SEM histórico: o que a migração criou não existe mais,
-- o que já existia continua. A igualdade completa do estado é conferida no CI (snapshot antes/depois).
\set ON_ERROR_STOP on
select public.teste_assert('rollback limpo: trigger de histórico removida',
  not exists (select 1 from pg_trigger where tgname = 'aluno_mov_tabulacao_so_gestao' and not tgisinternal));
select public.teste_assert('rollback limpo: RPC removida',
  to_regprocedure('public.registrar_administrativo_termo_fisico(text,text)') is null);
select public.teste_assert('rollback limpo: função da trigger removida',
  to_regprocedure('public.aluno_movimentacao_tabulacao_so_gestao()') is null);
select public.teste_assert('rollback limpo: tabela de contenção removida',
  to_regclass('public.termo_fisico_contencao') is null);
select public.teste_assert('rollback limpo: linhas de termo físico removidas do catálogo',
  (select count(*) from public.tabulacoes where codigo in ('TERMO_FISICO_EM_ANDAMENTO','TERMO_FISICO_ARQUIVADO')) = 0);
select public.teste_assert('rollback limpo: barreira de estado (_encerramento_so_gestao) preservada',
  to_regprocedure('public._encerramento_so_gestao()') is not null);
select public.teste_assert('rollback limpo: outras tabulações intactas',
  (select count(*) from public.tabulacoes where codigo = 'CONTATAR') = 1);

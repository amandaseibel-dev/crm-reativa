-- Após a recusa do rollback: catálogo, trigger de histórico, função e barreira de estado
-- permanecem intactos; dados (com histórico ou sem) permanecem. Roda depois do rollback.
\set ON_ERROR_STOP on

select public.teste_assert('preservação: as duas linhas do catálogo estão exatamente como a migração gravou',
  (select count(*) from (values
      ('TERMO_FISICO_EM_ANDAMENTO','Possui termo físico assinado, em andamento',355),
      ('TERMO_FISICO_ARQUIVADO','Termo físico arquivado, quitado',356)
    ) as e(codigo,rotulo,ordem)
    join public.tabulacoes t on t.codigo = e.codigo
   where t.rotulo = e.rotulo and t.ordem = e.ordem and t.ativa and t.somente_gestao
     and t.criado_por = 'migration_termo_fisico' and t.criado_em = timestamptz '2026-11-14 00:00:00-03'
     and t.grupo = 'ADMINISTRATIVO' and t.retorno_modo = 'NENHUM' and t.proxima_acao = 'CONTATAR'
     and t.efeito_desfecho is null and t.redireciona_para_email is null
     and t.atualizado_em is null and t.desativada_em is null) = 2);

select public.teste_assert('preservação: trigger de histórico instalada',
  exists (select 1 from pg_trigger where tgname = 'aluno_mov_tabulacao_so_gestao' and not tgisinternal));
select public.teste_assert('preservação: função da barreira de histórico instalada',
  to_regprocedure('public.aluno_movimentacao_tabulacao_so_gestao()') is not null);
select public.teste_assert('preservação: barreira de estado (_encerramento_so_gestao) instalada em alunos',
  exists (select 1 from pg_trigger where tgname = 'trg_encerramento_so_gestao' and not tgisinternal));
select public.teste_assert('preservação: outras tabulações intactas',
  (select count(*) from public.tabulacoes where codigo = 'CONTATAR') = 1);

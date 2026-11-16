-- Impressão digital dos DADOS que o rollback poderia alterar: contenção, catálogo de termo,
-- estado do aluno de teste e histórico de termo. Uma linha (md5). Usada antes e depois de cada
-- tentativa de rollback recusado: igualdade prova que a recusa não alterou nada.
\set ON_ERROR_STOP on
select md5(coalesce(string_agg(x, '|' order by x), '')) from (
  select 'contencao:' || coalesce((select contencao_ativa::text || '/' || alterado_por from public.termo_fisico_contencao where id), '-') as x
  union all select 'tab:' || t.codigo || ':' || t.rotulo || ':' || t.ativa::text || ':' || t.somente_gestao::text || ':' || coalesce(t.criado_por, '-')
    from public.tabulacoes t where t.codigo in ('TERMO_FISICO_EM_ANDAMENTO', 'TERMO_FISICO_ARQUIVADO')
  union all select 'aluno:' || coalesce(a.status_atual, '-') || ':' || coalesce(a.status_jornada, '-') || ':' || coalesce(a.status_acionamento, '-')
    from public.alunos a where a.id = 'a0000000-0000-0000-0000-000000000042'
  union all select 'hist_termo:' || count(*)::text from public.aluno_movimentacoes
    where tipo = 'REGISTRO_ADMINISTRATIVO' or status_novo like 'TERMO_FISICO_%'
) s;

-- Impressão digital dos DADOS que o rollback da 20261114120000 poderia alterar, uma linha por item.
-- Cobre: contenção (linha inteira), catálogo de termo (linha inteira), histórico de termo (contagem),
-- alunos no estado de termo (contagem e linhas), e o aluno de teste (linha inteira).
-- Usada antes e depois de cada tentativa de rollback recusado (com snapshot_termo_fisico.sql, que cobre
-- funções, triggers, RLS e ACL). Igualdade prova que a recusa não alterou nada.
\set ON_ERROR_STOP on
select md5(coalesce(string_agg(x, '|' order by x), '')) from (
  select 'contencao:' || coalesce((select md5(t::text) from public.termo_fisico_contencao t), '-') as x
  union all select 'catalogo:' || t.codigo || ':' || md5(t::text) from public.tabulacoes t
   where t.codigo in ('TERMO_FISICO_EM_ANDAMENTO', 'TERMO_FISICO_ARQUIVADO')
  union all select 'catalogo_total:' || count(*)::text from public.tabulacoes
  union all select 'hist_termo:' || count(*)::text from public.aluno_movimentacoes
   where tipo = 'REGISTRO_ADMINISTRATIVO' or status_novo like 'TERMO_FISICO_%'
  union all select 'aluno_termo:' || a.id || ':' || md5(a::text) from public.alunos a
   where a.status_atual like 'TERMO_FISICO_%' or a.id = 'a0000000-0000-0000-0000-000000000042'
) s;

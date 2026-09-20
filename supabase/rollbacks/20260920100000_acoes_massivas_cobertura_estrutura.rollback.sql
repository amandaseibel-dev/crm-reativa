-- ROLLBACK de 20260920100000_acoes_massivas_cobertura_estrutura.sql
-- Aplicar DEPOIS dos rollbacks de 120000 e 110000 (as funcoes novas usam estas colunas).
-- Remove so o que a migration criou. Perde os vinculos lote_id e o log das previas
-- gerados desde entao; nada mais e tocado.

drop index if exists public.ix_aluno_mov_lote;
alter table public.aluno_movimentacoes drop column if exists lote_id;

alter table public.acoes_massivas_lotes drop constraint if exists acoes_massivas_lotes_previa_fk;
alter table public.acoes_massivas_lotes
  drop column if exists filtros,
  drop column if exists solicitado,
  drop column if exists encontrado,
  drop column if exists selecionado,
  drop column if exists previa_id,
  drop column if exists resumo_exclusoes,
  drop column if exists recencia_dias;

drop table if exists public.acoes_massivas_previas;

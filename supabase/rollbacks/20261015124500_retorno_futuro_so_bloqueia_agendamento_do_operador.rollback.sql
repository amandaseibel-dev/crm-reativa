-- ROLLBACK de 20261015124500_retorno_futuro_so_bloqueia_agendamento_do_operador
--
-- Devolve `retorno_futuro` ao comportamento anterior: QUALQUER data_retorno
-- futura volta a esconder o aluno das Acoes Massivas, inclusive a automatica
-- da tabulacao (96,5% dos casos em 15/10).
--
-- Estado em que este rollback e valido:
--   md5(pg_get_functiondef) APOS a migration = 9878ffd8b7dc404dcdf34d506d9c32e9
--   md5 ANTES da migration                   = cb618e31cf9d821a5f53692b978911d0
--   ACL nos dois estados: postgres=X/postgres ; authenticated=X/postgres ;
--   service_role=X/postgres (CREATE OR REPLACE preserva grants).
--
-- SO A REGRA E REVERTIDA. O patch (1) da migration apenas ACRESCENTOU
-- `a.retorno_origem` a CTE `pop`; `internal.patch_funcao_ancorada` recusa
-- desfazer patch aditivo (o texto novo seria pedaco da ancora: "patch
-- ambiguo"). A coluna fica e e INERTE -- ninguem a le depois que a regra volta
-- ao que era. Reaplicar a migration depois deste rollback funciona: o patch (1)
-- e pulado por idempotencia e o (2) volta a valer.

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$(k.data_retorno is not null and k.data_retorno > v_hoje and upper(coalesce(k.retorno_origem, '')) like 'OPERADOR%') as f_ret,$ancora$,
$novo$(k.data_retorno is not null and k.data_retorno > v_hoje) as f_ret,$novo$,
  1);

-- Comentario anterior. ATENCAO: eu nao capturei o comentario vivo antes de
-- troca-lo -- este texto e o do arquivo 20260920125244 do repo, que e a origem
-- do comentario (pg_get_functiondef nao carrega COMMENT, entao os patches de
-- 27/09 nao o alteraram). Se algum dia divergir, vale o que estiver no banco.
comment on function public.acoes_massivas_universo(jsonb) is
  'Fonte unica das Acoes Massivas: 1 linha por aluno com divida ativa, com cobertura (acionado no mes/hoje, nunca) e disponibilidade (um motivo de indisponibilidade). Leitura pura; alimenta previa, painel por ano e drill-down.';

delete from supabase_migrations.schema_migrations where version = '20261015124500';

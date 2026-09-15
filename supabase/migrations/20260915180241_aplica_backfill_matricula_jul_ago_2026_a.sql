-- APLICACAO DO BACKFILL DE MATRICULA PRIME -- lote jul/ago 2026, grupo A.
--
-- Esta chamada carrega SOMENTE lote, hash e quantidade. Nenhum pagamento_id,
-- nenhuma matricula, nenhum boleto, nenhum nome de arquivo. Por isso e seguro
-- que ela fique no historico de migrations e em `postgres_logs`.
--
-- O plano em si foi transportado pela Edge `backfill-matricula-carga` ate
-- `backfill_matricula_stage`, em 75 pedacos de ate 100 registros, e conferido
-- ali: 7.401 linhas, 7.401 pagamento_id distintos, 7.401 boletos distintos,
-- 2.905 matriculas, e o md5 recomputado dentro do banco igual ao do artefato
-- auditado no dry-run.
--
-- O motor vai, nesta ordem: travar o lote, conferir os invariantes da stage
-- contra o hash, conferir cada alvo contra `pagamentos`, gravar a trilha,
-- escrever UMA coluna e exigir ROW_COUNT = 7401. Qualquer desvio desfaz tudo.

select public.backfill_matricula_aplicar(
  'MATRICULA_SANTANDER_JUL_AGO_2026_A',
  '168e0a880f94536bee942bc018661f8c',
  7401
);
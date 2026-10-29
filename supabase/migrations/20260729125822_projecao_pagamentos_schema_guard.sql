-- =============================================================================
-- GUARD de parceria de schema: colunas de pagamentos usadas pelo detalhe.
-- Producao ja possui importacao_id e operador_ajustado_manualmente; staging
-- estava atras. add column if not exists => no-op em prod, cria em staging.
-- Nao altera dados. Nullable, sem default pesado.
-- =============================================================================
alter table public.pagamentos add column if not exists importacao_id uuid;
alter table public.pagamentos add column if not exists operador_ajustado_manualmente boolean not null default false;

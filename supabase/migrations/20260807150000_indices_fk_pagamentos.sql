-- Performance: índices de cobertura para chaves estrangeiras SEM índice nas
-- tabelas de pagamento/baixa (apontadas pelo performance advisor do Supabase,
-- categoria unindexed_foreign_keys). Sem índice, joins e DELETE/UPDATE que
-- filtram por essas FKs fazem sequential scan.
--
-- SEGURO: índice só ACELERA leitura/limpeza; não altera resultado nem
-- comportamento de nenhuma query. IF NOT EXISTS = idempotente.
--
-- NÃO aplicado automaticamente em prod nesta sessão (a pedido: prod em hold).
-- Aplicar quando autorizado; tabelas pequenas, criação rápida.

CREATE INDEX IF NOT EXISTS idx_acordos_titulos_importacao_id
  ON public.acordos_titulos (importacao_id);

CREATE INDEX IF NOT EXISTS idx_baixas_pagamento_acordo_id
  ON public.baixas_pagamento (acordo_id);

CREATE INDEX IF NOT EXISTS idx_baixas_pagamento_parcela_id
  ON public.baixas_pagamento (parcela_id);

CREATE INDEX IF NOT EXISTS idx_solic_conf_pagto_titulo_id
  ON public.solicitacoes_confirmacao_pagamento (titulo_id);

CREATE INDEX IF NOT EXISTS idx_solic_conf_pagto_acordo_id
  ON public.solicitacoes_confirmacao_pagamento (acordo_id);

CREATE INDEX IF NOT EXISTS idx_solic_conf_pagto_parcela_id
  ON public.solicitacoes_confirmacao_pagamento (parcela_id);

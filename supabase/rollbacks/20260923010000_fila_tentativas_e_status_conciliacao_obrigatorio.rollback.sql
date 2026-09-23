-- ROLLBACK de 20260923010000_fila_tentativas_e_status_conciliacao_obrigatorio
--
-- Volta o banco ao estado de 22/09/2026: fila sem contador de tentativas e
-- `pagamentos.status_conciliacao` podendo terminar a transacao nulo.
--
-- NAO desfaz nada de negocio: as duas protecoes so OBSERVAM e EXIGEM, nunca
-- escreveram pagamento, parcela, acordo ou baixa. Nenhum dado financeiro
-- passou por elas.
--
-- AS COLUNAS SAO APAGADAS, E ISSO E PERDA REAL: o historico de tentativas
-- acumulado desde a aplicacao vai junto. Nao ha como preserva-lo sem manter a
-- estrutura, e manter coluna orfa depois de um rollback e pior -- fica um dado
-- que ninguem alimenta e que a proxima leitura trata como verdade. Se o
-- historico importar, exporte antes:
--
--   select pagamento_id, primeira_tentativa_em, ultima_tentativa_em,
--          quantidade_tentativas
--     from public.fila_pagamento_sem_vinculo;

drop trigger if exists trg_pagamento_status_conciliacao_obrigatorio on public.pagamentos;
drop function if exists public._pagamento_status_conciliacao_obrigatorio();

drop trigger if exists trg_fila_pagamento_tentativa on public.fila_pagamento_sem_vinculo;
drop function if exists public._fila_pagamento_tentativa();

alter table public.fila_pagamento_sem_vinculo
  drop column if exists primeira_tentativa_em,
  drop column if exists ultima_tentativa_em,
  drop column if exists quantidade_tentativas;

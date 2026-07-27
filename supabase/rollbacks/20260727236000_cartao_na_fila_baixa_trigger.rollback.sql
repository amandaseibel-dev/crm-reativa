-- Rollback do hotfix "cartão na fila de baixa".
-- Remove o trigger, a função de trigger, a função canônica e o índice único
-- parcial. NÃO remove solicitações eventualmente já criadas (dados legítimos).
-- Obs.: reverter a Edge Function (documento-financeiro-url) é feito por deploy
-- da versão anterior, não por SQL.

DROP TRIGGER IF EXISTS trg_criar_solicitacao_confirmacao_por_comprovante
  ON public.links_pagamento;

DROP FUNCTION IF EXISTS public.tg_criar_solicitacao_confirmacao_por_comprovante();

DROP FUNCTION IF EXISTS public.garantir_solicitacao_cartao_na_fila(uuid);

DROP INDEX IF EXISTS public.uq_solic_confirmacao_por_comprovante_link;

-- Rollback do hotfix "cartão na fila de baixa".
-- Remove o trigger, a função e o índice único parcial. NÃO remove solicitações
-- eventualmente já criadas pelo trigger (dados legítimos na fila).

DROP TRIGGER IF EXISTS trg_criar_solicitacao_confirmacao_por_comprovante
  ON public.links_pagamento;

DROP FUNCTION IF EXISTS public.tg_criar_solicitacao_confirmacao_por_comprovante();

DROP INDEX IF EXISTS public.uq_solic_confirmacao_por_comprovante_link;

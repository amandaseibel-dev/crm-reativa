-- PLANO DE RECUPERAÇÃO — NÃO EXECUTAR AINDA (aguardando aval).
--
-- Regra do incidente: NÃO inserir os 164 automaticamente. Classificar os casos
-- e recuperar SOMENTE os acionáveis, reusando a função canônica idempotente
-- garantir_solicitacao_cartao_na_fila(link_id) (mesma regra do fluxo real).
--
-- CLASSIFICAÇÃO (produção, 2026-07-27) — base: 164 links de cartão com
-- comprovante e SEM solicitação vinculada por comprovante_link_id:
--   - 161 com o LINK já baixado (status BAIXA_REALIZADA / baixado_em);
--   - 147 com solicitação já CONFIRMADA para o aluno (pago por outro caminho);
--   - 137 com aluno QUITADO/baixado;
--   -  14 com solicitação ABERTA para o aluno (já visível por outro caminho);
--   -   0 sem data de comprovante;
--   =>  2 REALMENTE ACIONÁVEIS (pendentes de análise).
--
-- Ou seja: os "invisíveis" em sua quase totalidade já foram resolvidos pelo
-- fluxo de links (baixa) ou de confirmação. Inserir todos reabriria pagamentos
-- já liquidados. Recuperamos apenas os 2 acionáveis.
--
-- Critério ACIONÁVEL:
--   forma_pagamento='CARTAO' AND comprovante_url presente AND vínculo de aluno
--   válido AND sem solicitação (aberta/qualquer) por comprovante_link_id AND
--   link não baixado AND sem solicitação aberta/confirmada do aluno AND aluno
--   não quitado/baixado.

-- (0) Conferência — reveja a lista antes de recuperar:
--   SELECT lp.id, lp.aluno_id, lp.aluno_nome, lp.valor, lp.comprovante_anexado_em, lp.status
--   FROM public.links_pagamento lp
--   WHERE lp.forma_pagamento='CARTAO' AND lp.comprovante_url IS NOT NULL AND lp.aluno_id IS NOT NULL
--     AND lp.status <> 'BAIXA_REALIZADA' AND lp.baixado_em IS NULL AND lp.baixa_realizada_em IS NULL
--     AND NOT EXISTS (SELECT 1 FROM public.solicitacoes_confirmacao_pagamento s WHERE s.comprovante_link_id=lp.id)
--     AND NOT EXISTS (SELECT 1 FROM public.solicitacoes_confirmacao_pagamento s WHERE s.aluno_id=lp.aluno_id
--                       AND s.status IN ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO','PAGAMENTO_CONFIRMADO'))
--     AND NOT EXISTS (SELECT 1 FROM public.alunos a WHERE a.id::text=lp.aluno_id
--                       AND a.status_jornada IN ('QUITADO','QUITADO_MANUAL','BAIXA_REALIZADA'));

-- (1) Recuperação idempotente dos ACIONÁVEIS (usa a função canônica).
-- Pré-requisito: migração 20260727236000 já aplicada (função + índice único).
-- Rodar SEMPRE em transação e conferir a contagem antes do COMMIT.

BEGIN;

SELECT lp.id AS link_id,
       public.garantir_solicitacao_cartao_na_fila(lp.id) AS resultado
FROM public.links_pagamento lp
WHERE lp.forma_pagamento = 'CARTAO'
  AND lp.comprovante_url IS NOT NULL
  AND lp.aluno_id IS NOT NULL
  AND lp.status <> 'BAIXA_REALIZADA'
  AND lp.baixado_em IS NULL
  AND lp.baixa_realizada_em IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.solicitacoes_confirmacao_pagamento s
    WHERE s.comprovante_link_id = lp.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.solicitacoes_confirmacao_pagamento s
    WHERE s.aluno_id = lp.aluno_id
      AND s.status IN ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO','PAGAMENTO_CONFIRMADO'))
  AND NOT EXISTS (
    SELECT 1 FROM public.alunos a
    WHERE a.id::text = lp.aluno_id
      AND a.status_jornada IN ('QUITADO','QUITADO_MANUAL','BAIXA_REALIZADA'));

-- Esperado: 2 linhas, cada uma com resultado ->> 'criada' = true.

-- COMMIT;   -- só após conferência
ROLLBACK;    -- padrão seguro: não efetiva nada até aprovação

-- PLANO DE RECUPERAÇÃO — NÃO EXECUTAR AINDA (aguardando aval).
--
-- Objetivo: para cada comprovante de CARTÃO já anexado em links_pagamento que
-- não possui solicitação vinculada, criar EXATAMENTE 1 solicitação pendente
-- (mesma regra do trigger), sem duplicar e sem tocar em fluxos existentes.
--
-- Escopo medido em produção (2026-07-27):
--   - 164 links de cartão com comprovante e SEM solicitação por comprovante_link_id.
--   - 150 deles sem NENHUMA solicitação aberta do aluno (totalmente invisíveis).
--   - 14 têm alguma solicitação aberta do aluno por outro caminho (revisar antes
--     de decidir se também recebem a solicitação vinculada ao comprovante).
--
-- Decisão de escopo (a confirmar com a gestão):
--   (A) Recuperar os 164 (idempotente por comprovante_link_id) — recomendado,
--       pois cada comprovante deve ter sua própria solicitação vinculada; OU
--   (B) Recuperar só os 150 sem fila aberta, tratando os 14 manualmente.
-- O script abaixo implementa (A). Para (B), descomente o filtro NOT EXISTS de
-- solicitação aberta do aluno.
--
-- Segurança: rodar SEMPRE dentro de BEGIN/…/ (conferir contagem) /COMMIT|ROLLBACK.
-- Pré-requisito: aplicar antes a migração do trigger (o índice único parcial
-- uq_solic_confirmacao_por_comprovante_link garante que não haja duplicidade).

BEGIN;

WITH alvo AS (
  SELECT lp.*
  FROM public.links_pagamento lp
  WHERE lp.forma_pagamento = 'CARTAO'
    AND lp.comprovante_url IS NOT NULL
    AND lp.aluno_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.solicitacoes_confirmacao_pagamento s
      WHERE s.comprovante_link_id = lp.id
    )
    -- (B) Descomente para pular alunos que já têm solicitação aberta:
    -- AND NOT EXISTS (
    --   SELECT 1 FROM public.solicitacoes_confirmacao_pagamento s2
    --   WHERE s2.aluno_id = lp.aluno_id
    --     AND s2.status IN ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
    -- )
)
INSERT INTO public.solicitacoes_confirmacao_pagamento (
  aluno_id, aluno_nome, aluno_cpf,
  operador_email, operador_nome,
  valor_informado, forma_pagamento,
  comprovante_link_id, motivo, status,
  criado_em, atualizado_em
)
SELECT
  a.aluno_id, a.aluno_nome, a.aluno_cpf,
  coalesce(a.comprovante_anexado_por, a.operador_email),
  a.operador_nome,
  a.valor, a.forma_pagamento,
  a.id,
  'Recuperação: comprovante de cartão já anexado sem solicitação — aguardando vínculo/baixa pela gestão.',
  'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO',
  coalesce(a.comprovante_anexado_em, now()), now()
FROM alvo a
ON CONFLICT (comprovante_link_id) WHERE comprovante_link_id IS NOT NULL DO NOTHING;

-- Conferir antes de efetivar:
--   SELECT count(*) FROM solicitacoes_confirmacao_pagamento
--   WHERE status='PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO' AND comprovante_link_id IS NOT NULL;

-- COMMIT;   -- só após conferência
ROLLBACK;    -- padrão seguro: não efetiva nada até aprovação

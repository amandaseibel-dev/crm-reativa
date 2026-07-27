-- Hotfix: comprovante de pagamento no CARTÃO não entra na fila de baixa.
--
-- Sintoma (produção):
--   O operador anexa o comprovante do cartão (fluxo ComprovantePagamento.jsx ->
--   Edge Function documento-financeiro-url -> RPC docfin_vincular), que apenas
--   grava links_pagamento.comprovante_url. NENHUMA solicitação é criada em
--   solicitacoes_confirmacao_pagamento, então o caso NUNCA aparece na "Minha
--   Fila de Baixa de Pagamentos" (FilaConfirmacaoPagamento.jsx, que lê
--   solicitacoes_confirmacao_pagamento com status em aberto). O único caminho
--   que cria a solicitação hoje é a tabulação manual separada
--   ConfirmarPagamento.jsx (INSERT explícito), que para o cartão não é feita.
--
-- Diagnóstico read-only (produção, 2026-07-27):
--   - links_pagamento forma_pagamento='CARTAO': 253; com comprovante: 164.
--   - desses 164, solicitações vinculadas por comprovante_link_id: 0.
--   - 150 não têm NENHUMA solicitação aberta para o aluno (invisíveis na fila).
--   - Não existe trigger em links_pagamento que crie solicitação ao anexar
--     comprovante (só há audit/histórico/sync). Causa confirmada.
--
-- Correção (idempotente, mínima, escopada ao CARTÃO):
--   Trigger AFTER INSERT OR UPDATE OF comprovante_url em links_pagamento que,
--   quando há comprovante anexado num link de cartão com aluno, cria EXATAMENTE
--   1 solicitação pendente (status PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO) caso
--   ainda não exista solicitação vinculada àquele comprovante (comprovante_link_id).
--   - status "aguardando vínculo" = aparece na fila da gestão, operador NÃO
--     confirma/baixa/estorna; Amanda/Fernanda/Amanda ADM vinculam e baixam.
--   - reenvio não duplica: docfin_vincular só grava comprovante_url quando NULL
--     (não dispara de novo) e, ainda assim, o guard NOT EXISTS + índice único
--     parcial garantem no máximo 1 solicitação por comprovante.
--   - não mexe em fluxos anteriores: escopo forma_pagamento='CARTAO' e status
--     'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO' não aciona os triggers existentes
--     (_nao_confirmar_se_ja_quitado / _aluno_aguardando_baixa_ao_confirmar só
--     agem em 'AGUARDANDO_CONFIRMACAO').
--
-- Esta migração NÃO faz recuperação histórica dos 164/150 casos atuais — isso
-- fica no plano separado supabase/recovery/ (executar depois, com aval).

-- 1) Backstop de unicidade: no máximo 1 solicitação por comprovante (link).
CREATE UNIQUE INDEX IF NOT EXISTS uq_solic_confirmacao_por_comprovante_link
  ON public.solicitacoes_confirmacao_pagamento (comprovante_link_id)
  WHERE comprovante_link_id IS NOT NULL;

-- 2) Função do trigger.
CREATE OR REPLACE FUNCTION public.tg_criar_solicitacao_confirmacao_por_comprovante()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Só age quando há comprovante anexado, é cartão e há aluno identificado.
  IF NEW.comprovante_url IS NULL
     OR upper(coalesce(NEW.forma_pagamento, '')) <> 'CARTAO'
     OR NEW.aluno_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Idempotência: já existe solicitação vinculada a este comprovante/link.
  IF EXISTS (
    SELECT 1 FROM public.solicitacoes_confirmacao_pagamento
    WHERE comprovante_link_id = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  -- Cria exatamente 1 solicitação pendente (aguardando vínculo pela gestão).
  -- unique_violation (corrida de duplo anexo) é absorvido: nunca quebra o anexo.
  BEGIN
    INSERT INTO public.solicitacoes_confirmacao_pagamento (
      aluno_id, aluno_nome, aluno_cpf,
      operador_email, operador_nome,
      valor_informado, forma_pagamento,
      comprovante_link_id, motivo, status,
      criado_em, atualizado_em
    ) VALUES (
      NEW.aluno_id, NEW.aluno_nome, NEW.aluno_cpf,
      coalesce(NEW.comprovante_anexado_por, NEW.operador_email),
      NEW.operador_nome,
      NEW.valor, NEW.forma_pagamento,
      NEW.id,
      'Comprovante de pagamento no cartão anexado pelo operador — aguardando vínculo/baixa pela gestão.',
      'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO',
      now(), now()
    );
  EXCEPTION WHEN unique_violation THEN
    -- Outra transação já criou a solicitação para este comprovante. OK.
    NULL;
  END;

  RETURN NEW;
END;
$function$;

-- 3) Trigger: dispara ao anexar (comprovante_url passa a não-nulo) ou em insert
-- já com comprovante. docfin_vincular grava comprovante_url só quando NULL.
DROP TRIGGER IF EXISTS trg_criar_solicitacao_confirmacao_por_comprovante
  ON public.links_pagamento;
CREATE TRIGGER trg_criar_solicitacao_confirmacao_por_comprovante
  AFTER INSERT OR UPDATE OF comprovante_url
  ON public.links_pagamento
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_criar_solicitacao_confirmacao_por_comprovante();

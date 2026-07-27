-- Hotfix: comprovante de pagamento no CARTÃO não entra na fila de baixa.
--
-- Sintoma (produção):
--   O operador anexa o comprovante do cartão (ComprovantePagamento.jsx -> Edge
--   Function documento-financeiro-url -> RPC docfin_vincular), que apenas grava
--   links_pagamento.comprovante_url. NENHUMA solicitação é criada em
--   solicitacoes_confirmacao_pagamento, então o caso NUNCA aparece na "Minha
--   Fila de Baixa" (FilaConfirmacaoPagamento.jsx lê solicitacoes_confirmacao_
--   pagamento por status em aberto). O único caminho que cria a solicitação hoje
--   é a tabulação manual ConfirmarPagamento.jsx, que para o cartão não é feita.
--
-- Diagnóstico read-only (produção, 2026-07-27):
--   - links_pagamento forma_pagamento='CARTAO': 253; com comprovante: 164.
--   - desses 164, solicitações vinculadas por comprovante_link_id: 0.
--   - não existe função/trigger que crie a solicitação ao vincular o comprovante.
--
-- Correção (fluxo real): função server-side idempotente
--   garantir_solicitacao_cartao_na_fila(link_id), chamada pela Edge Function
--   após o vínculo bem-sucedido E no caminho de 409 ja_vinculado, e também por
--   um trigger de defesa (mesma função, sem lógica duplicada). Ela cria no
--   máximo 1 solicitação pendente (PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO) por
--   comprovante e devolve a existente quando já houver. Nunca confirma/baixa.

-- 1) Backstop de unicidade: no máximo 1 solicitação por comprovante (link).
CREATE UNIQUE INDEX IF NOT EXISTS uq_solic_confirmacao_por_comprovante_link
  ON public.solicitacoes_confirmacao_pagamento (comprovante_link_id)
  WHERE comprovante_link_id IS NOT NULL;

-- 2) Função canônica idempotente (única fonte da regra). SECURITY DEFINER e
--    executável só pelo backend (service_role/postgres); revogada do público.
CREATE OR REPLACE FUNCTION public.garantir_solicitacao_cartao_na_fila(p_link_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_link      public.links_pagamento%ROWTYPE;
  v_existente public.solicitacoes_confirmacao_pagamento%ROWTYPE;
  v_id        uuid;
BEGIN
  SELECT * INTO v_link FROM public.links_pagamento WHERE id = p_link_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'link_nao_encontrado');
  END IF;

  -- Regras de guarda: só cartão, com comprovante e com vínculo de aluno válido.
  IF upper(coalesce(v_link.forma_pagamento, '')) <> 'CARTAO' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'nao_cartao');
  END IF;
  IF v_link.comprovante_url IS NULL OR btrim(v_link.comprovante_url) = '' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'sem_comprovante');
  END IF;
  IF v_link.aluno_id IS NULL OR btrim(v_link.aluno_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'sem_vinculo_aluno');
  END IF;

  -- Idempotência: já existe solicitação para este comprovante -> devolve-a
  -- (aberta ou já finalizada; nunca reabre nem duplica).
  SELECT * INTO v_existente
    FROM public.solicitacoes_confirmacao_pagamento
    WHERE comprovante_link_id = p_link_id
    ORDER BY criado_em ASC
    LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'criada', false,
                              'solicitacao_id', v_existente.id, 'status', v_existente.status);
  END IF;

  -- Cria exatamente 1 solicitação pendente. Nunca confirma nem efetiva baixa.
  -- unique_violation (corrida) -> devolve a que a outra transação criou.
  BEGIN
    INSERT INTO public.solicitacoes_confirmacao_pagamento (
      aluno_id, aluno_nome, aluno_cpf,
      operador_email, operador_nome,
      valor_informado, forma_pagamento,
      comprovante_link_id, motivo, status,
      criado_em, atualizado_em
    ) VALUES (
      v_link.aluno_id, v_link.aluno_nome, v_link.aluno_cpf,
      coalesce(v_link.comprovante_anexado_por, v_link.operador_email),
      v_link.operador_nome,
      v_link.valor, v_link.forma_pagamento,
      v_link.id,
      'Comprovante de pagamento no cartão anexado pelo operador — aguardando vínculo/baixa pela gestão.',
      'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO',
      now(), now()
    ) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_id FROM public.solicitacoes_confirmacao_pagamento
      WHERE comprovante_link_id = p_link_id LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'criada', false, 'solicitacao_id', v_id,
                              'status', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO');
  END;

  RETURN jsonb_build_object('ok', true, 'criada', true, 'solicitacao_id', v_id,
                            'status', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO');
END;
$function$;

-- Só backend: revoga de todos e concede a service_role/postgres.
REVOKE ALL ON FUNCTION public.garantir_solicitacao_cartao_na_fila(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.garantir_solicitacao_cartao_na_fila(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.garantir_solicitacao_cartao_na_fila(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.garantir_solicitacao_cartao_na_fila(uuid) TO service_role;

-- 3) Trigger de DEFESA (novos vínculos), usando a MESMA função (sem duplicar
--    lógica). É SECURITY DEFINER (dono postgres), então a chamada à função
--    canônica ocorre com o privilégio do dono mesmo se o UPDATE vier de outro
--    papel. docfin_vincular grava comprovante_url só quando NULL: não redispara.
CREATE OR REPLACE FUNCTION public.tg_criar_solicitacao_confirmacao_por_comprovante()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.comprovante_url IS NOT NULL
     AND upper(coalesce(NEW.forma_pagamento, '')) = 'CARTAO'
     AND NEW.aluno_id IS NOT NULL THEN
    PERFORM public.garantir_solicitacao_cartao_na_fila(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_criar_solicitacao_confirmacao_por_comprovante
  ON public.links_pagamento;
CREATE TRIGGER trg_criar_solicitacao_confirmacao_por_comprovante
  AFTER INSERT OR UPDATE OF comprovante_url
  ON public.links_pagamento
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_criar_solicitacao_confirmacao_por_comprovante();

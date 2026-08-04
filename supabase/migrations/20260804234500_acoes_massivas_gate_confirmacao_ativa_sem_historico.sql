-- CORREÇÃO SEMÂNTICA do gate de confirmação (complementa 20260804233000).
--
-- Bloquear SOMENTE quando o aluno está ATUALMENTE aguardando análise/confirmação
-- financeira. Nunca bloquear por registro histórico já concluído.
--
-- Diagnóstico (prod, 2026-08-04, alunos livres):
--   - situacao_operacional=AGUARDANDO_CONFIRMACAO: 2732/2732 têm solicitação aberta (0 stale).
--   - AGUARDANDO_BAIXA cru: 223/3553 já terminais (ENCERRADO_VIA_ACORDO/PAGAMENTO_CONFIRMADO).
--   - BAIXA_REALIZADA: baixa concluída = terminal (20/24 solicitação recente PAGAMENTO_CONFIRMADO).
--   - AGUARDANDO_COMPROVANTE: comprovante ainda não enviado (nenhum com pagamento em análise).
--   - Textos "ENVIADO AO FINANCEIRO" etc.: todos terminais ou sem solicitação.
--
-- Âncora do gate = pendência realmente aberta (solicitação AGUARDANDO_CONFIRMACAO /
-- PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO) + espelho canônico atual
-- situacao_operacional=AGUARDANDO_CONFIRMACAO (recalculado por trigger/cron).
-- Espelhos de texto que envelhecem foram REMOVIDOS: quando ainda ativos, o aluno
-- continua bloqueado pela solicitação aberta; quando terminais, volta às demais regras.
--
-- Efeito: 3617 -> 3353 bloqueados; 264 históricos liberados; 0 falsos positivos.

CREATE OR REPLACE FUNCTION public.aluno_em_confirmacao_pagamento(p_aluno_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.solicitacoes_confirmacao_pagamento s
      WHERE s.aluno_id::text = p_aluno_id
        AND s.status IN ('AGUARDANDO_CONFIRMACAO', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
    ) THEN 'Aguardando confirmação financeira'
    WHEN EXISTS (
      SELECT 1 FROM public.alunos a
      WHERE a.id::text = p_aluno_id
        AND public.normalizar_status_acionamento(a.situacao_operacional) = 'AGUARDANDO CONFIRMACAO'
    ) THEN 'Aguardando confirmação financeira'
    ELSE NULL
  END;
$function$;

-- Consulta inicial: remove o drop cru redundante de AGUARDANDO_BAIXA/BAIXA_REALIZADA
-- (ativos já saem pelo gate; terminais voltam às demais regras). Mantém QUITADO*.
CREATE OR REPLACE FUNCTION public.buscar_candidatos_acoes_massivas(
  p_ano_vencimento text DEFAULT NULL::text,
  p_limite integer DEFAULT 6000,
  p_dias_minimo_sem_contato integer DEFAULT NULL::integer,
  p_apenas_nunca_acionado boolean DEFAULT false)
RETURNS TABLE(id uuid, nome text, telefone text, email text, data_ultimo_acionamento timestamp with time zone, valor numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT a.id, a.nome, a.telefone, a.email, a.data_ultimo_acionamento,
         COALESCE(c.total_em_aberto, 0) AS valor
  FROM public.alunos a
  LEFT JOIN public.casos c ON c.aluno_id = a.id AND c.operador_email IS NULL
  WHERE a.responsavel_atual_email IS NULL
    AND (a.data_retorno IS NULL OR a.data_retorno <= current_date)
    AND public.aluno_em_confirmacao_pagamento(a.id::text) IS NULL
    AND coalesce(a.status_jornada,'') NOT IN ('QUITADO','QUITADO_MANUAL')
    AND coalesce(a.status_atual,'')   NOT IN ('QUITADO','QUITADO_MANUAL')
    AND NOT public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada)
    AND NOT EXISTS (
      SELECT 1 FROM public.acordos ac WHERE ac.aluno_id = a.id AND ac.status = 'ATIVO'
    )
    AND (
      p_ano_vencimento IS NULL OR EXISTS (
        SELECT 1 FROM public.acordos_titulos at
        WHERE at.aluno_id = a.id
          AND at.situacao = 'ABERTO'
          AND at.vencimento BETWEEN (p_ano_vencimento || '-01-01')::date AND (p_ano_vencimento || '-12-31')::date
      )
    )
    AND (
      p_apenas_nunca_acionado
        AND a.data_ultimo_acionamento IS NULL
      OR NOT p_apenas_nunca_acionado
    )
    AND (
      p_dias_minimo_sem_contato IS NULL
      OR a.data_ultimo_acionamento IS NULL
      OR a.data_ultimo_acionamento <= (now() - (p_dias_minimo_sem_contato || ' days')::interval)
    )
  ORDER BY a.data_ultimo_acionamento ASC NULLS FIRST
  LIMIT p_limite;
END;
$function$;

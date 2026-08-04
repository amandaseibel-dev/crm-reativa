-- REGRA ABSOLUTA: nenhum aluno em confirmação de pagamento pode entrar em Ações Massivas.
--
-- Fonte única de verdade (gate canônico) aplicado em 4 pontos:
--   1) consulta inicial dos candidatos (buscar_candidatos_acoes_massivas)
--   2) prévia da campanha (acoes_massivas_previa)
--   3) seleção dos destinatários (a lista elegível já sai sem os bloqueados)
--   4) imediatamente antes do envio (registrar_acao_massiva revalida no backend)
--
-- Considera BLOQUEADO quando existir qualquer um dos sinais:
--   - solicitação pendente na fila de confirmação (AGUARDANDO_CONFIRMACAO ou
--     PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO);
--   - alunos.situacao_operacional = AGUARDANDO_CONFIRMACAO;
--   - comprovante aguardando análise / pagamento informado ainda não confirmado /
--     baixa em validação financeira (status_jornada/status_atual/status_baixa_pagamento
--     em AGUARDANDO_BAIXA, BAIXA_REALIZADA, AGUARDANDO_COMPROVANTE, ENVIADO AO
--     FINANCEIRO, AGUARDANDO CONFIRMACAO DE PAGAMENTO, AGUARDANDO ENVIO FINANCEIRO).
--
-- Nota: "link enviado ao aluno" (LINK_ENVIADO_AO_ALUNO) NÃO bloqueia por si só —
-- só bloqueia quando já representa pagamento em validação (então cai em AGUARDANDO_BAIXA
-- / baixa em análise), exatamente como a regra qualifica.

-- ---------------------------------------------------------------------------
-- 1) GATE CANÔNICO — devolve o motivo do bloqueio, ou NULL se está liberado.
-- ---------------------------------------------------------------------------
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
        AND (
          public.normalizar_status_acionamento(a.situacao_operacional) = 'AGUARDANDO CONFIRMACAO'
          OR public.normalizar_status_acionamento(a.status_jornada) = ANY (ARRAY[
               'AGUARDANDO BAIXA', 'BAIXA REALIZADA', 'AGUARDANDO COMPROVANTE',
               'ENVIADO AO FINANCEIRO', 'AGUARDANDO CONFIRMACAO DE PAGAMENTO',
               'AGUARDANDO ENVIO FINANCEIRO'])
          OR public.normalizar_status_acionamento(a.status_atual) = ANY (ARRAY[
               'AGUARDANDO BAIXA', 'BAIXA REALIZADA', 'AGUARDANDO COMPROVANTE',
               'AGUARDANDO CONFIRMACAO DE PAGAMENTO'])
          OR public.normalizar_status_acionamento(a.status_baixa_pagamento) = 'BAIXA REALIZADA'
        )
    ) THEN 'Aguardando confirmação financeira'
    ELSE NULL
  END;
$function$;

-- ---------------------------------------------------------------------------
-- 2) REVALIDAÇÃO EM LOTE — dado um conjunto de ids, devolve os BLOQUEADOS + motivo.
--    Usada pela prévia (contagem/lista mascarada) e como checagem antes do envio.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acoes_massivas_revalidar_confirmacao(p_aluno_ids text[])
RETURNS TABLE(aluno_id text, motivo text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT x.id, public.aluno_em_confirmacao_pagamento(x.id)
  FROM unnest(COALESCE(p_aluno_ids, '{}'::text[])) AS x(id)
  WHERE public.aluno_em_confirmacao_pagamento(x.id) IS NOT NULL;
$function$;

-- ---------------------------------------------------------------------------
-- 3) CONSULTA INICIAL — endurecida com o gate canônico (ponto 1).
--    (mantém os demais filtros existentes; só ADICIONA a exclusão por confirmação)
-- ---------------------------------------------------------------------------
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
    -- GATE CANÔNICO: fora qualquer caso em confirmação de pagamento.
    AND public.aluno_em_confirmacao_pagamento(a.id::text) IS NULL
    AND coalesce(a.status_jornada,'') NOT IN ('AGUARDANDO_BAIXA','BAIXA_REALIZADA','QUITADO','QUITADO_MANUAL')
    AND coalesce(a.status_atual,'')   NOT IN ('AGUARDANDO_BAIXA','BAIXA_REALIZADA','QUITADO','QUITADO_MANUAL')
    -- Fora: cancelamento de cobranca, juridico e quitados (encerrados operacionalmente)
    AND NOT public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada)
    -- Fora (por ora): alunos com acordo ativo -- so entram apos ajuste da base
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

-- ---------------------------------------------------------------------------
-- 4) PRÉVIA DA CAMPANHA — devolve ELEGÍVEIS + EXCLUÍDOS por confirmação (ponto 2).
--    Roda os MESMOS filtros-base, mas particiona pelo gate (não some silenciosamente):
--    o front mostra "Excluídos por confirmação de pagamento: X" com a lista mascarada.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acoes_massivas_previa(
  p_ano_vencimento text DEFAULT NULL::text,
  p_limite integer DEFAULT 6000,
  p_dias_minimo_sem_contato integer DEFAULT NULL::integer,
  p_apenas_nunca_acionado boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  WITH base AS (
    SELECT a.id, a.nome, a.telefone, a.email, a.data_ultimo_acionamento,
           COALESCE(c.total_em_aberto, 0) AS valor,
           public.aluno_em_confirmacao_pagamento(a.id::text) AS motivo_conf
    FROM public.alunos a
    LEFT JOIN public.casos c ON c.aluno_id = a.id AND c.operador_email IS NULL
    WHERE a.responsavel_atual_email IS NULL
      AND (a.data_retorno IS NULL OR a.data_retorno <= current_date)
      -- quitados/encerrados nunca entram (não são "confirmação", são encerrados)
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
        p_apenas_nunca_acionado AND a.data_ultimo_acionamento IS NULL
        OR NOT p_apenas_nunca_acionado
      )
      AND (
        p_dias_minimo_sem_contato IS NULL
        OR a.data_ultimo_acionamento IS NULL
        OR a.data_ultimo_acionamento <= (now() - (p_dias_minimo_sem_contato || ' days')::interval)
      )
    ORDER BY a.data_ultimo_acionamento ASC NULLS FIRST
    LIMIT p_limite
  )
  SELECT jsonb_build_object(
    'elegiveis', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', id, 'nome', nome, 'telefone', telefone, 'email', email,
               'data_ultimo_acionamento', data_ultimo_acionamento, 'valor', valor)
             ORDER BY data_ultimo_acionamento ASC NULLS FIRST)
      FROM base WHERE motivo_conf IS NULL), '[]'::jsonb),
    'excluidos_confirmacao', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'aluno', split_part(COALESCE(nome, '-'), ' ', 1) || ' ***',
               'motivo', motivo_conf)
             ORDER BY nome)
      FROM base WHERE motivo_conf IS NOT NULL), '[]'::jsonb),
    'total_excluidos_confirmacao', (SELECT count(*) FROM base WHERE motivo_conf IS NOT NULL)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5) REGISTRO/ENVIO — revalida no backend imediatamente antes de registrar (ponto 4).
--    Caso que entrou em confirmação depois da prévia é REMOVIDO aqui: não recebe
--    update, não gera movimentação, não perde operador, não conta como envio.
--    Devolve os ids efetivamente registrados (o front gera o Excel só com eles).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_acao_massiva(
  p_aluno_ids text[],
  p_canal text,
  p_arquivo text,
  p_registrado_por_nome text,
  p_registrado_por_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id       text;
  v_motivo   text;
  v_retorno  date        := (current_date + 10);
  v_agora    timestamptz := now();
  v_tipo     text        := CASE WHEN p_canal = 'WHATSAPP' THEN 'ACAO_MASSIVA_EXTERNA' ELSE 'ACAO_MASSIVA_EXTERNA_EMAIL' END;
  v_registrados text[]   := '{}';
  v_excluidos_conf int   := 0;
  v_excluidos jsonb      := '[]'::jsonb;
  v_mov int              := 0;
BEGIN
  FOREACH v_id IN ARRAY COALESCE(p_aluno_ids, '{}'::text[]) LOOP
    -- REVALIDAÇÃO no backend (não confia só no filtro da tela).
    v_motivo := public.aluno_em_confirmacao_pagamento(v_id);
    IF v_motivo IS NOT NULL THEN
      v_excluidos_conf := v_excluidos_conf + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', v_motivo);
      CONTINUE;  -- não toca em nada: sem update, sem movimentação, sem mexer no operador.
    END IF;

    UPDATE public.alunos
       SET data_retorno            = v_retorno,
           status_acionamento      = 'Ação massiva externa enviada — aguardando retorno',
           data_ultimo_acionamento = v_agora
     WHERE id::text = v_id
       AND responsavel_atual_email IS NULL;  -- trava extra: nunca mexer em caso com operador

    IF FOUND THEN
      INSERT INTO public.aluno_movimentacoes
        (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
      VALUES (v_id, v_tipo,
        'Ação de estímulo enviada por fora do CRM via '
          || CASE WHEN p_canal = 'WHATSAPP' THEN 'WhatsApp' ELSE 'e-mail' END
          || ' (planilha ' || COALESCE(p_arquivo, '-')
          || '), sem operador vinculado. Retorno agendado para '
          || to_char(v_retorno, 'DD/MM/YYYY') || '.',
        COALESCE(p_registrado_por_nome, p_registrado_por_email), p_registrado_por_email, v_agora);
      v_mov := v_mov + 1;
      v_registrados := v_registrados || v_id;
    ELSE
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Caso com operador vinculado ou inexistente');
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'registrados',            COALESCE(array_length(v_registrados, 1), 0),
    'ids_registrados',        to_jsonb(v_registrados),
    'excluidos_confirmacao',  v_excluidos_conf,
    'movimentacoes_criadas',  v_mov,
    'ids_excluidos',          v_excluidos
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6) CONTADOR DE PROGRESSO — também respeita o gate (não conta bloqueados).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.total_elegiveis_acoes_massivas(p_canal text DEFAULT 'WHATSAPP'::text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'total_elegivel', count(*) FILTER (
      WHERE (p_canal = 'WHATSAPP' AND a.telefone IS NOT NULL) OR (p_canal = 'EMAIL' AND a.email IS NOT NULL)
    ),
    'ja_acionado', count(*) FILTER (
      WHERE ((p_canal = 'WHATSAPP' AND a.telefone IS NOT NULL) OR (p_canal = 'EMAIL' AND a.email IS NOT NULL))
        AND a.data_retorno IS NOT NULL AND a.data_retorno > current_date
    )
  )
  FROM public.alunos a
  JOIN public.casos c ON c.aluno_id = a.id
  WHERE a.responsavel_atual_email IS NULL
    AND c.operador_email IS NULL
    AND c.total_em_aberto >= 100
    AND public.aluno_em_confirmacao_pagamento(a.id::text) IS NULL
    AND NOT public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada)
    AND NOT EXISTS (
      SELECT 1 FROM public.acordos ac WHERE ac.aluno_id = a.id AND ac.status = 'ATIVO'
    );
$function$;

-- ---------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.aluno_em_confirmacao_pagamento(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acoes_massivas_revalidar_confirmacao(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acoes_massivas_previa(text, integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_acao_massiva(text[], text, text, text, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.registrar_acao_massiva(text[], text, text, text, text) FROM anon;

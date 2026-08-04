-- ============================================================================
-- HOTFIX SEGURANÇA — Ações Massivas
-- 1) acoes_massivas_previa: REVOKE anon/public; gate de gestão/executor técnico;
--    NÃO retorna telefone/e-mail completos (mascarados) — anti-enumeração.
-- 2) registrar_acao_massiva: REVOKE anon/public; gate; AUTORIA pelo JWT (ignora
--    p_registrado_por_email); retorna contatos completos SÓ dos alunos
--    efetivamente registrados (superfície de escrita gestão-gated e auditada).
-- 3) Executor técnico: auth.role()='service_role' OU (sem JWT E session_user
--    técnico) — JWT nulo isolado NÃO autoriza. Sem EXECUTE p/ public/anon.
-- Preserva agendamento futuro (nenhum agendador criado aqui). Não toca outras
-- policies/grants. Base: docs/seguranca/PREMISSA_SEGURANCA_PROJETO.md
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) acoes_massivas_previa  (gate + mascaramento)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acoes_massivas_previa(
  p_ano_vencimento text DEFAULT NULL, p_limite integer DEFAULT 6000,
  p_dias_minimo_sem_contato integer DEFAULT NULL, p_apenas_nunca_acionado boolean DEFAULT false,
  p_unidade text DEFAULT NULL, p_curso text DEFAULT NULL, p_apenas_ja_acionado boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public' SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_result jsonb;
  -- Executor técnico: service_role (Edge Function) OU sessão interna do banco
  -- (pg_cron/psql) com session_user técnico. JWT nulo isolado NÃO basta.
  v_sistema boolean := (auth.role() = 'service_role')
                       OR (auth.jwt() IS NULL AND session_user IN ('postgres','reativa_responsavel_executor'));
BEGIN
  -- GATE: só gestão autenticada (identidade do JWT via usuario_e_gestao) ou executor técnico.
  IF NOT v_sistema AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'Acesso negado: previa de acao massiva restrita a gestao.' USING ERRCODE = '42501';
  END IF;

  WITH sol_conf AS MATERIALIZED (
    SELECT DISTINCT s.aluno_id FROM public.solicitacoes_confirmacao_pagamento s
    WHERE s.status IN ('AGUARDANDO_CONFIRMACAO', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
  ),
  base AS MATERIALIZED (
    SELECT a.id, a.nome, a.telefone, a.email, a.data_ultimo_acionamento,
           COALESCE(c.total_em_aberto, 0) AS valor,
           CASE
             WHEN public.normalizar_status_acionamento(a.situacao_operacional) = 'AGUARDANDO CONFIRMACAO' THEN 'Aguardando confirmação financeira'
             WHEN a.id::text IN (SELECT aluno_id FROM sol_conf) THEN 'Aguardando confirmação financeira'
             ELSE NULL END AS motivo_conf
    FROM public.alunos a
    LEFT JOIN public.casos c ON c.aluno_id = a.id AND c.operador_email IS NULL
    WHERE a.responsavel_atual_email IS NULL
      AND (a.data_retorno IS NULL OR a.data_retorno <= current_date)
      AND coalesce(a.status_jornada,'') NOT IN ('QUITADO','QUITADO_MANUAL')
      AND coalesce(a.status_atual,'')   NOT IN ('QUITADO','QUITADO_MANUAL')
      AND (p_unidade IS NULL OR a.unidade = p_unidade)
      AND (p_curso   IS NULL OR a.curso   = p_curso)
      AND NOT public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada)
      AND NOT EXISTS (SELECT 1 FROM public.acordos ac WHERE ac.aluno_id = a.id AND ac.status = 'ATIVO')
      AND (p_ano_vencimento IS NULL OR EXISTS (
        SELECT 1 FROM public.acordos_titulos at WHERE at.aluno_id = a.id AND at.situacao = 'ABERTO'
          AND at.vencimento BETWEEN (p_ano_vencimento || '-01-01')::date AND (p_ano_vencimento || '-12-31')::date))
      AND (NOT p_apenas_nunca_acionado OR a.data_ultimo_acionamento IS NULL)
      AND (NOT p_apenas_ja_acionado    OR a.data_ultimo_acionamento IS NOT NULL)
      AND (p_dias_minimo_sem_contato IS NULL OR a.data_ultimo_acionamento IS NULL
        OR a.data_ultimo_acionamento <= (now() - (p_dias_minimo_sem_contato || ' days')::interval))
    ORDER BY a.data_ultimo_acionamento ASC NULLS FIRST
    LIMIT p_limite
  ),
  masc AS (
    SELECT id, data_ultimo_acionamento, valor, motivo_conf, nome,
           nullif(regexp_replace(coalesce(telefone,''),'\D','','g'),'') AS tel_dig,
           btrim(coalesce(email,'')) AS email_t
    FROM base
  )
  SELECT jsonb_build_object(
    'elegiveis', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'nome', split_part(coalesce(nome,'-'),' ',1) || ' ***',              -- não retorna nome completo
        'tem_telefone', (tel_dig IS NOT NULL),
        'tem_email',    (email_t <> '' AND position('@' in email_t) > 1),
        'telefone_mascarado', CASE WHEN tel_dig IS NULL THEN NULL
                                   WHEN length(tel_dig) >= 4 THEN '••••'||right(tel_dig,4) ELSE '••••' END,
        'email_mascarado',    CASE WHEN email_t <> '' AND position('@' in email_t) > 1
                                   THEN left(email_t,1)||'•••@'||split_part(email_t,'@',2) ELSE NULL END,
        'data_ultimo_acionamento', data_ultimo_acionamento, 'valor', valor)
      ORDER BY data_ultimo_acionamento ASC NULLS FIRST) FROM masc WHERE motivo_conf IS NULL), '[]'::jsonb),
    'excluidos_confirmacao', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'aluno', split_part(COALESCE(nome, '-'), ' ', 1) || ' ***', 'motivo', motivo_conf)
      ORDER BY nome) FROM masc WHERE motivo_conf IS NOT NULL), '[]'::jsonb),
    'total_excluidos_confirmacao', (SELECT count(*) FROM masc WHERE motivo_conf IS NOT NULL)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 2) registrar_acao_massiva  (gate + autoria JWT + contatos só dos registrados)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_acao_massiva(
  p_aluno_ids text[], p_canal text, p_arquivo text,
  p_registrado_por_nome text, p_registrado_por_email text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_id text; v_motivo text;
  v_retorno date := (current_date + 10);
  v_agora timestamptz := now();
  v_tipo text := CASE WHEN p_canal = 'WHATSAPP' THEN 'ACAO_MASSIVA_EXTERNA' ELSE 'ACAO_MASSIVA_EXTERNA_EMAIL' END;
  v_registrados text[] := '{}';
  v_excluidos_conf int := 0; v_excluidos jsonb := '[]'::jsonb; v_mov int := 0;
  v_sistema boolean := (auth.role() = 'service_role')
                       OR (auth.jwt() IS NULL AND session_user IN ('postgres','reativa_responsavel_executor'));
  v_autor_email text; v_autor_nome text; v_contatos jsonb;
BEGIN
  -- GATE: só gestão autenticada ou executor técnico. p_registrado_por_email é IGNORADO.
  IF NOT v_sistema AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'Acesso negado: registrar acao massiva restrito a gestao ou executor tecnico.' USING ERRCODE = '42501';
  END IF;

  -- AUTORIA CONFIÁVEL: só do JWT (ou SISTEMA quando executor técnico).
  IF v_sistema THEN
    v_autor_email := 'SISTEMA'; v_autor_nome := 'SISTEMA';
  ELSE
    v_autor_email := lower(coalesce(auth.email(), ''));
    v_autor_nome  := coalesce(nullif(auth.jwt() ->> 'name',''), v_autor_email);
  END IF;

  FOREACH v_id IN ARRAY COALESCE(p_aluno_ids, '{}'::text[]) LOOP
    v_motivo := public.aluno_em_confirmacao_pagamento(v_id);
    IF v_motivo IS NOT NULL THEN
      v_excluidos_conf := v_excluidos_conf + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', v_motivo);
      CONTINUE;
    END IF;

    UPDATE public.alunos
       SET data_retorno = v_retorno,
           status_acionamento = 'Ação massiva externa enviada — aguardando retorno',
           data_ultimo_acionamento = v_agora
     WHERE id::text = v_id AND responsavel_atual_email IS NULL;

    IF FOUND THEN
      INSERT INTO public.aluno_movimentacoes
        (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
      VALUES (v_id, v_tipo,
        'Ação de estímulo enviada por fora do CRM via '
          || CASE WHEN p_canal = 'WHATSAPP' THEN 'WhatsApp' ELSE 'e-mail' END
          || ' (planilha ' || COALESCE(p_arquivo, '-')
          || '), sem operador vinculado. Retorno agendado para ' || to_char(v_retorno, 'DD/MM/YYYY') || '.',
        v_autor_nome, v_autor_email, v_agora);           -- autoria do JWT/SISTEMA
      v_mov := v_mov + 1; v_registrados := v_registrados || v_id;
    ELSE
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Caso com operador vinculado ou inexistente');
    END IF;
  END LOOP;

  -- Contatos completos SÓ dos efetivamente registrados (p/ a planilha de envio).
  v_contatos := COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'aluno_id', a.id::text, 'nome', a.nome, 'telefone', a.telefone, 'email', a.email))
    FROM public.alunos a WHERE a.id::text = ANY(v_registrados)), '[]'::jsonb);

  RETURN jsonb_build_object(
    'registrados', COALESCE(array_length(v_registrados, 1), 0),
    'ids_registrados', to_jsonb(v_registrados),
    'excluidos_confirmacao', v_excluidos_conf,
    'movimentacoes_criadas', v_mov,
    'autor_email', v_autor_email,
    'executado_por', CASE WHEN v_sistema THEN 'SISTEMA' ELSE 'USUARIO' END,
    'contatos', v_contatos,
    'ids_excluidos', v_excluidos);
END;
$function$;

-- ----------------------------------------------------------------------------
-- 3) Privilégios: sem PUBLIC/anon; authenticated (gate interno) + service_role.
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.registrar_acao_massiva(text[],text,text,text,text)                     FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean) TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.registrar_acao_massiva(text[],text,text,text,text)                     TO authenticated, service_role;

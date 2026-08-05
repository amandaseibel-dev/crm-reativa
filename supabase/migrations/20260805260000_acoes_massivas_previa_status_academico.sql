-- ============================================================================
-- Ações Massivas — prévia passa a retornar o STATUS ACADÊMICO do aluno
-- ============================================================================
-- Somente EXIBIÇÃO. A gestão precisa ver o status acadêmico (ex.: "Aguardando
-- Matrícula", "Término do Contrato", "Trancado") na prévia para decidir o
-- público. Reaproveita `alunos.situacao_academica` e `alunos.curso` (modalidade),
-- já usados em Penetração por Ano e no bloco Dados Acadêmicos da ficha.
--
-- Mesma assinatura da versão em PROD (20260805120000) → mantém grants/REVOKE.
-- Não altera filtros, base elegível, mascaramento de contato nem regras de gate.
-- Nada de PII nova: situacao_academica/curso não são dado pessoal sensível.
-- ============================================================================

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
           nullif(btrim(a.situacao_academica),'') AS situacao_academica,
           nullif(btrim(a.curso),'')              AS curso,
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
           situacao_academica, curso,
           nullif(regexp_replace(coalesce(telefone,''),'\D','','g'),'') AS tel_dig,
           btrim(coalesce(email,'')) AS email_t
    FROM base
  )
  SELECT jsonb_build_object(
    'elegiveis', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'nome', split_part(coalesce(nome,'-'),' ',1) || ' ***',              -- não retorna nome completo
        'situacao_academica', situacao_academica,
        'curso', curso,
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

-- Preserva o hardening da 20260805120000 (sem EXECUTE p/ public/anon).
REVOKE EXECUTE ON FUNCTION public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean) TO authenticated, service_role;

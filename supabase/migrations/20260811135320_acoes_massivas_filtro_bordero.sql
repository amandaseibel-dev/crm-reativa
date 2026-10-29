-- Ações Massivas: filtro por Borderô (carteira importada)
--
-- Contexto: quando chega uma "carteira nova" (borderôs importados), a gestão
-- precisa acionar EXATAMENTE aquele lote. Os títulos do borderô ficam em
-- acordos_titulos com importacao_id = id da importação (tipo BORDERO).
-- A prévia de ações massivas não tinha como isolar esse recorte — só unidade/
-- curso/ano/valor. Aqui adicionamos:
--   1) acoes_massivas_borderos()  -> lista os borderôs importados p/ o seletor
--   2) novo parâmetro p_importacao_ids em acoes_massivas_previa()
--
-- Segurança: ambas SECURITY DEFINER com gate usuario_e_gestao() (mesmo padrão
-- da prévia). Sem exposição de PII nova.

-- 1) Lista de borderôs importados (p/ o dropdown do frontend) --------------
CREATE OR REPLACE FUNCTION public.acoes_massivas_borderos()
RETURNS TABLE(
  importacao_id uuid,
  arquivo_nome  text,
  criado_em     timestamptz,
  qtd_alunos    bigint
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT i.id, i.arquivo_nome, i.created_at,
         count(DISTINCT at2.aluno_id) AS qtd_alunos
  FROM public.importacoes i
  LEFT JOIN public.acordos_titulos at2 ON at2.importacao_id = i.id
  WHERE i.tipo = 'BORDERO'
    AND public.usuario_e_gestao()
    AND i.created_at >= now() - interval '120 days'
  GROUP BY i.id, i.arquivo_nome, i.created_at
  ORDER BY i.created_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.acoes_massivas_borderos() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acoes_massivas_borderos() TO authenticated;

-- 2) Prévia com filtro de borderô (importacao_id) --------------------------
CREATE OR REPLACE FUNCTION public.acoes_massivas_previa(
  p_ano_vencimento text DEFAULT NULL::text,
  p_limite integer DEFAULT 6000,
  p_dias_minimo_sem_contato integer DEFAULT NULL::integer,
  p_apenas_nunca_acionado boolean DEFAULT false,
  p_unidade text DEFAULT NULL::text,
  p_curso text DEFAULT NULL::text,
  p_apenas_ja_acionado boolean DEFAULT false,
  p_situacao_academica text DEFAULT NULL::text,
  p_importacao_ids uuid[] DEFAULT NULL::uuid[]
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_result jsonb;
  v_sistema boolean := (auth.role() = 'service_role')
                       OR (auth.jwt() IS NULL AND session_user IN ('postgres','reativa_responsavel_executor'));
BEGIN
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
      AND (p_situacao_academica IS NULL OR nullif(btrim(a.situacao_academica),'') = p_situacao_academica)
      AND NOT public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada)
      AND NOT EXISTS (SELECT 1 FROM public.acordos ac WHERE ac.aluno_id = a.id AND ac.status = 'ATIVO')
      AND (p_ano_vencimento IS NULL OR EXISTS (
        SELECT 1 FROM public.acordos_titulos at WHERE at.aluno_id = a.id AND at.situacao = 'ABERTO'
          AND at.vencimento BETWEEN (p_ano_vencimento || '-01-01')::date AND (p_ano_vencimento || '-12-31')::date))
      -- NOVO: restringe à(s) carteira(s) importada(s) selecionada(s)
      AND (p_importacao_ids IS NULL OR EXISTS (
        SELECT 1 FROM public.acordos_titulos at3
        WHERE at3.aluno_id = a.id AND at3.importacao_id = ANY(p_importacao_ids)))
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
        'nome', split_part(coalesce(nome,'-'),' ',1) || ' ***',
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

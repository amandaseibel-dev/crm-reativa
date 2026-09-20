-- ROLLBACK de 20260920110000_acoes_massivas_universo.sql
-- Restaura acoes_massivas_previa (15 parametros) exatamente como estava em
-- producao em 20/09/2026 (pg_get_functiondef) e remove as funcoes novas.
-- Aplicar TAMBEM o rollback de 20260920120000 se ele ja tiver sido aplicado
-- (a ordem e 120000 primeiro, depois este).

drop function if exists public.acoes_massivas_drilldown(jsonb, integer, text, text, integer, integer);
drop function if exists public.acoes_massivas_cobertura_por_ano(jsonb);
drop function if exists public.acoes_massivas_previa(
  text, integer, integer, boolean, text, text, boolean, text, uuid[], text, text, numeric, numeric, text, text,
  text, integer, boolean);
drop function if exists public.acoes_massivas_universo(jsonb);
drop function if exists public.acoes_massivas_motivo_texto(text);
drop function if exists public.acoes_massivas_tipo_cobertura(text);

CREATE OR REPLACE FUNCTION public.acoes_massivas_previa(p_ano_vencimento text DEFAULT NULL::text, p_limite integer DEFAULT 6000, p_dias_minimo_sem_contato integer DEFAULT NULL::integer, p_apenas_nunca_acionado boolean DEFAULT false, p_unidade text DEFAULT NULL::text, p_curso text DEFAULT NULL::text, p_apenas_ja_acionado boolean DEFAULT false, p_situacao_academica text DEFAULT NULL::text, p_importacao_ids uuid[] DEFAULT NULL::uuid[], p_matricula text DEFAULT NULL::text, p_canal text DEFAULT NULL::text, p_valor_min numeric DEFAULT NULL::numeric, p_valor_max numeric DEFAULT NULL::numeric, p_operador_email text DEFAULT NULL::text, p_tipo_cobranca text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_result jsonb;
  -- Operador responsavel escolhido na tela. NULL ou vazio = base livre / regra atual.
  v_operador text := lower(nullif(btrim(p_operador_email), ''));
  -- Tipo de cobranca. Sem tipo = tela anterior (REGRA_ANTERIOR).
  v_tipo text := coalesce(upper(nullif(btrim(p_tipo_cobranca), '')), 'REGRA_ANTERIOR');
  v_sistema boolean := (auth.role() = 'service_role')
                       OR (auth.jwt() IS NULL AND session_user IN ('postgres','reativa_responsavel_executor'));
BEGIN
  IF NOT v_sistema AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'Acesso negado: previa de acao massiva restrita a gestao.' USING ERRCODE = '42501';
  END IF;
  IF nullif(btrim(p_tipo_cobranca), '') IS NOT NULL
     AND v_tipo NOT IN ('MENSALIDADES', 'ACORDOS_VENCIDOS', 'MENSALIDADES_E_ACORDOS') THEN
    RAISE EXCEPTION 'Tipo de cobranca invalido: %', p_tipo_cobranca USING ERRCODE = '22023';
  END IF;

  WITH sol_conf AS MATERIALIZED (
    SELECT DISTINCT s.aluno_id FROM public.solicitacoes_confirmacao_pagamento s
    WHERE s.status IN ('AGUARDANDO_CONFIRMACAO', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
  ),
  -- Quem ja consta liquidado no Prime nao entra, nem aparece (Amanda, 08/09).
  liq_prime AS MATERIALIZED (
    SELECT lp.aluno_id FROM public.acoes_massivas_liquidados_prime() lp
  ),
  -- Populacao do tipo de cobranca (mensalidade sem acordo em dia, ou acordo
  -- vencido) com as marcas. Sem tipo nem e calculada.
  tipo_cob AS MATERIALIZED (
    SELECT tc.aluno_id, tc.tem_mensalidade, tc.tem_acordo_vencido
      FROM public.acoes_massivas_tipo_cobranca_alunos() tc
     WHERE v_tipo <> 'REGRA_ANTERIOR'
  ),
  -- Conjunto COMPLETO que atende aos filtros da tela -- sem limite. E daqui que
  -- sai o total honesto; `base` e so a fatia que a tela vai listar.
  filtrado AS MATERIALIZED (
    SELECT a.id, a.nome, a.telefone, a.email, a.data_ultimo_acionamento,
           nullif(btrim(a.situacao_academica),'') AS situacao_academica,
           nullif(btrim(a.curso),'')              AS curso,
           a.unidade,
           coalesce(tc.tem_mensalidade, false)    AS tem_mensalidade,
           coalesce(tc.tem_acordo_vencido, false) AS tem_acordo_vencido,
           -- a opcao escolhida aceita este aluno? (sem tipo: sempre)
           (v_tipo = 'REGRA_ANTERIOR'
            OR public.acoes_massivas_tipo_cobranca_corresponde(v_tipo, tc.tem_mensalidade, tc.tem_acordo_vencido)) AS no_tipo,
           COALESCE(c.total_em_aberto, 0) AS valor,
           CASE
             WHEN public.normalizar_status_acionamento(a.situacao_operacional) = 'AGUARDANDO CONFIRMACAO' THEN 'Aguardando confirmação financeira'
             WHEN a.id::text IN (SELECT aluno_id FROM sol_conf) THEN 'Aguardando confirmação financeira'
             ELSE NULL END AS motivo_conf
    FROM public.alunos a
    -- LATERAL sem a condicao de dono: aluno com responsavel tambem tem valor.
    -- LIMIT 1 para nao duplicar a linha de quem tem mais de um caso.
    LEFT JOIN LATERAL (
      SELECT c2.total_em_aberto
      FROM public.casos c2
      WHERE c2.aluno_id = a.id
      -- Com operador escolhido, o valor vem do caso DELE. Sem operador a
      -- primeira chave e falsa em todas as linhas e a ordem e a de sempre.
      ORDER BY (v_operador IS NOT NULL AND c2.operador_email IS NOT DISTINCT FROM v_operador) DESC,
               c2.total_em_aberto DESC NULLS LAST
      LIMIT 1
    ) c ON true
    LEFT JOIN tipo_cob tc ON tc.aluno_id = a.id
    WHERE (
            -- Sem operador escolhido: a regra de sempre, sem tirar nem por.
            (v_operador IS NULL AND (
            a.responsavel_atual_email IS NULL
            -- Ter dono nao quer dizer estar sendo trabalhado.
            OR (p_apenas_nunca_acionado AND a.data_ultimo_acionamento IS NULL)
            -- Passou do prazo sem acionamento: entra na acao, tendo dono ou nao.
            OR (p_dias_minimo_sem_contato IS NOT NULL
                AND a.data_ultimo_acionamento IS NOT NULL
                AND a.data_ultimo_acionamento <= (now() - (p_dias_minimo_sem_contato || ' days')::interval))
            ))
            -- Com operador escolhido: SO a carteira atual dele. Livre e aluno de
            -- outro operador nao entram. As travas abaixo valem igual.
            OR (v_operador IS NOT NULL AND a.responsavel_atual_email = v_operador)
          )
      AND NOT EXISTS (SELECT 1 FROM liq_prime lp WHERE lp.aluno_id = a.id)
      AND (a.data_retorno IS NULL OR a.data_retorno <= current_date)
      AND coalesce(a.status_jornada,'') NOT IN ('QUITADO','QUITADO_MANUAL')
      AND coalesce(a.status_atual,'')   NOT IN ('QUITADO','QUITADO_MANUAL')
      AND (p_unidade IS NULL OR a.unidade = ANY(string_to_array(p_unidade, '|')))
      AND (p_matricula IS NULL OR (
        CASE WHEN EXISTS (
               SELECT 1 FROM public.prime_contratos pc
                WHERE pc.cpf = lpad(regexp_replace(coalesce(a.cpf,''),'\D','','g'),11,'0')
                  AND pc.valid_from >= public.semestre_corrente_inicio()
                  AND pc.status = 'Confirmado')
             THEN 'CONFIRMADA' ELSE 'NAO_CONFIRMADA' END = p_matricula))
      AND (p_curso   IS NULL OR a.curso   = p_curso)
      AND (p_situacao_academica IS NULL OR nullif(btrim(a.situacao_academica),'') = ANY(string_to_array(p_situacao_academica, '|')))
      AND NOT public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada)
      -- Sem tipo (tela anterior): acordo ativo fica fora, como sempre.
      -- Com tipo: so a populacao de tipo_cob. Acordo em dia fica fora de todas.
      AND (v_tipo <> 'REGRA_ANTERIOR'
           OR NOT EXISTS (SELECT 1 FROM public.acordos ac WHERE ac.aluno_id = a.id AND ac.status = 'ATIVO'))
      AND (v_tipo = 'REGRA_ANTERIOR' OR tc.aluno_id IS NOT NULL)
      AND (p_ano_vencimento IS NULL OR EXISTS (
        SELECT 1 FROM public.acordos_titulos at WHERE at.aluno_id = a.id AND at.situacao = 'ABERTO'
          AND at.vencimento BETWEEN (p_ano_vencimento || '-01-01')::date AND (p_ano_vencimento || '-12-31')::date))
      AND (p_importacao_ids IS NULL OR EXISTS (
        SELECT 1 FROM public.acordos_titulos at3
        WHERE at3.aluno_id = a.id AND at3.importacao_id = ANY(p_importacao_ids)))
      AND (NOT p_apenas_nunca_acionado OR a.data_ultimo_acionamento IS NULL)
      AND (NOT p_apenas_ja_acionado    OR a.data_ultimo_acionamento IS NOT NULL)
      AND (p_dias_minimo_sem_contato IS NULL OR a.data_ultimo_acionamento IS NULL
        OR a.data_ultimo_acionamento <= (now() - (p_dias_minimo_sem_contato || ' days')::interval))
      -- Canal e valor entram AQUI, antes do corte. Era o que fazia a tela
      -- devolver um punhado de linhas e parecer que a base tinha acabado.
      AND (p_canal IS NULL
           OR (upper(p_canal) = 'WHATSAPP'
               AND nullif(regexp_replace(coalesce(a.telefone,''),'\D','','g'),'') IS NOT NULL)
           OR (upper(p_canal) = 'EMAIL'
               AND btrim(coalesce(a.email,'')) <> '' AND position('@' in btrim(a.email)) > 1))
      AND (p_valor_min IS NULL OR COALESCE(c.total_em_aberto, 0) >= p_valor_min)
      AND (p_valor_max IS NULL OR COALESCE(c.total_em_aberto, 0) <= p_valor_max)
  ),
  base AS MATERIALIZED (
    SELECT * FROM filtrado
    WHERE no_tipo
    ORDER BY data_ultimo_acionamento ASC NULLS FIRST
    LIMIT p_limite
  ),
  masc AS (
    SELECT id, data_ultimo_acionamento, valor, motivo_conf, nome,
           situacao_academica, curso, unidade,
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
        'unidade', unidade,
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
    'total_excluidos_confirmacao', (SELECT count(*) FROM masc WHERE motivo_conf IS NOT NULL),
    'prime_extrato_em', (SELECT max(e.coletado_em)::date FROM public.prime_extrato e),
    -- Quantos alunos atendem aos filtros da tela, sem limite nenhum.
    'total_elegivel_filtros', (SELECT count(*) FROM filtrado WHERE motivo_conf IS NULL AND no_tipo),
    -- Qual carteira a previa recortou (NULL = base livre / regra atual).
    'operador_email', v_operador,
    -- Tipo de cobranca aplicado.
    'tipo_cobranca', v_tipo,
    -- Quantidade por opcao, com todos os demais filtros enviados ao banco e
    -- sem o limite da lista -- pela MESMA regra das opcoes. Mais quantos acordos
    -- vencidos tambem tem mensalidade (so informativo; ja estao nos acordos).
    'contagem_tipo', CASE WHEN v_tipo = 'REGRA_ANTERIOR' THEN NULL ELSE (
      SELECT jsonb_build_object(
        'mensalidades', count(*) FILTER (WHERE public.acoes_massivas_tipo_cobranca_corresponde('MENSALIDADES', tem_mensalidade, tem_acordo_vencido)),
        'acordos_vencidos', count(*) FILTER (WHERE public.acoes_massivas_tipo_cobranca_corresponde('ACORDOS_VENCIDOS', tem_mensalidade, tem_acordo_vencido)),
        'mensalidades_e_acordos_vencidos', count(*) FILTER (WHERE tem_mensalidade AND tem_acordo_vencido),
        'total_unico', count(*) FILTER (WHERE public.acoes_massivas_tipo_cobranca_corresponde('MENSALIDADES_E_ACORDOS', tem_mensalidade, tem_acordo_vencido)))
      FROM filtrado WHERE motivo_conf IS NULL) END
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

revoke all on function public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text,text,numeric,numeric,text,text) from public, anon;
grant execute on function public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[],text,text,numeric,numeric,text,text) to authenticated, service_role;

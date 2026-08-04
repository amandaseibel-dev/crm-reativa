-- Ações Massivas: corrige o "statement timeout" na Buscar prévia e adiciona
-- filtros por UNIDADE e por CURSO (modalidade), mantendo o filtro por ANO.
--
-- CAUSA-RAIZ DO TIMEOUT: acoes_massivas_previa chamava
-- aluno_em_confirmacao_pagamento(a.id) por linha. Essa função faz
-- `aluno_id::text = ...` e `a.id::text = ...`, anulando os índices → um seq
-- scan por candidato (300 a 6000 chamadas). A prévia batia ~7,7s, encostando
-- no statement_timeout padrão (8s); qualquer latência estourava.
--
-- CORREÇÃO: coletar o conjunto de alunos "em confirmação" UMA vez (CTE
-- materializada) e decidir inline, sem função por linha. Warm cai para ~0,7s.
-- Também damos statement_timeout próprio de 60s para blindar picos de cache frio.
--
-- FILTROS NOVOS: p_unidade (alunos.unidade) e p_curso (alunos.curso = modalidade).
-- Em branco não filtram — quem não tem o dado continua elegível.

-- Índices para os filtros novos (equality em unidade/curso).
CREATE INDEX IF NOT EXISTS idx_alunos_unidade ON public.alunos (unidade);
CREATE INDEX IF NOT EXISTS idx_alunos_curso   ON public.alunos (curso);

-- A assinatura muda (novos parâmetros), então dropamos a versão antiga.
DROP FUNCTION IF EXISTS public.acoes_massivas_previa(text, integer, integer, boolean);

CREATE OR REPLACE FUNCTION public.acoes_massivas_previa(
  p_ano_vencimento         text    DEFAULT NULL,
  p_limite                 integer DEFAULT 6000,
  p_dias_minimo_sem_contato integer DEFAULT NULL,
  p_apenas_nunca_acionado  boolean DEFAULT false,
  p_unidade                text    DEFAULT NULL,
  p_curso                  text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  WITH sol_conf AS MATERIALIZED (
    -- Conjunto de alunos aguardando confirmação financeira (uma varredura só).
    SELECT DISTINCT s.aluno_id
    FROM public.solicitacoes_confirmacao_pagamento s
    WHERE s.status IN ('AGUARDANDO_CONFIRMACAO', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
  ),
  base AS MATERIALIZED (
    SELECT a.id, a.nome, a.telefone, a.email, a.data_ultimo_acionamento,
           COALESCE(c.total_em_aberto, 0) AS valor,
           CASE
             WHEN public.normalizar_status_acionamento(a.situacao_operacional) = 'AGUARDANDO CONFIRMACAO'
               THEN 'Aguardando confirmação financeira'
             WHEN a.id::text IN (SELECT aluno_id FROM sol_conf)
               THEN 'Aguardando confirmação financeira'
             ELSE NULL
           END AS motivo_conf
    FROM public.alunos a
    LEFT JOIN public.casos c ON c.aluno_id = a.id AND c.operador_email IS NULL
    WHERE a.responsavel_atual_email IS NULL
      AND (a.data_retorno IS NULL OR a.data_retorno <= current_date)
      AND coalesce(a.status_jornada,'') NOT IN ('QUITADO','QUITADO_MANUAL')
      AND coalesce(a.status_atual,'')   NOT IN ('QUITADO','QUITADO_MANUAL')
      AND (p_unidade IS NULL OR a.unidade = p_unidade)
      AND (p_curso   IS NULL OR a.curso   = p_curso)
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

-- Opções para popular os dropdowns de filtro na tela (valores reais, ordenados
-- por volume — os canônicos ficam no topo; formas raras/mojibake ao fim).
CREATE OR REPLACE FUNCTION public.acoes_massivas_filtros()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'unidades', COALESCE((
      SELECT jsonb_agg(valor ORDER BY qtd DESC)
      FROM (
        SELECT unidade AS valor, count(*) AS qtd
        FROM public.alunos
        WHERE unidade IS NOT NULL AND unidade <> ''
        GROUP BY unidade
      ) u), '[]'::jsonb),
    'cursos', COALESCE((
      SELECT jsonb_agg(valor ORDER BY qtd DESC)
      FROM (
        SELECT curso AS valor, count(*) AS qtd
        FROM public.alunos
        WHERE curso IS NOT NULL AND curso <> ''
        GROUP BY curso
      ) c), '[]'::jsonb)
  );
$function$;

GRANT EXECUTE ON FUNCTION public.acoes_massivas_previa(text, integer, integer, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acoes_massivas_filtros() TO authenticated;

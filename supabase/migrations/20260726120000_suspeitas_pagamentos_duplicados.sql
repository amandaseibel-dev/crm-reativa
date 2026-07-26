-- Aba "Suspeitas de pagamentos duplicados" (Projeção Hora a Hora).
--
-- Etapa de TRIAGEM read-only: apenas registra a decisão manual sobre grupos
-- com indício OBJETIVO de duplicidade (mesmo numero_parcela_completo / mesma
-- referência bancária repetida). NÃO estorna, NÃO zera valores, NÃO recalcula
-- projeção/metas/ranking/honorários e NÃO altera os pagamentos originais.
--
-- Carga inicial: somente os grupos comprovados 1,2,3,4,5 e 7 do diagnóstico.
-- A parcela 6 (título 65643) é EXCLUÍDA de propósito — os dois pagamentos são
-- legítimos (documentado no importador). O caso Petry já foi corrigido antes e
-- não entra (linha estornada). Os 964 indeterminados não entram.

BEGIN;

-- 1) Tabela de triagem (uma linha por grupo/parcela suspeita).
CREATE TABLE IF NOT EXISTS public.suspeitas_pagamento_duplicado (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chave_grupo text NOT NULL,                 -- numero_parcela_completo (referência bancária)
  titulo_numero text,
  status text NOT NULL DEFAULT 'PENDENTE_VALIDACAO'
    CHECK (status IN ('PENDENTE_VALIDACAO','LEGITIMO','DUPLICIDADE_CONFIRMADA')),
  exige_conferencia_manual boolean NOT NULL DEFAULT false,
  -- Sugestão VISUAL apenas (não é decisão): linha maior a manter, menor suspeita.
  pagamento_sugerido_manter_id uuid,
  pagamento_sugerido_duplicado_id uuid,
  -- Decisão manual (preenchida só quando alguém valida).
  pagamento_manter_id uuid,
  pagamento_duplicado_id uuid,
  motivo text,
  decidido_por_email text,
  decidido_por_nome text,
  decidido_em timestamptz,
  -- Conjunto de pagamentos já considerados na última decisão (para saber quando
  -- uma linha NOVA justifica reabrir o grupo). Array jsonb de uuids (text).
  pagamentos_analisados jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Histórico de decisões anteriores preservado ao reabrir.
  historico_decisoes jsonb NOT NULL DEFAULT '[]'::jsonb,
  origem_deteccao text,          -- 'SEED' | 'TRIGGER_INSERT' | 'TRIGGER_INSERT_REABERTURA'
  detectado_em timestamptz,
  ultima_deteccao_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_suspeita_chave UNIQUE (chave_grupo)
);

-- Índice para o count por referência bancária feito pelo trigger a cada insert.
CREATE INDEX IF NOT EXISTS idx_pagamentos_numero_parcela_completo
  ON public.pagamentos (numero_parcela_completo);

COMMENT ON TABLE public.suspeitas_pagamento_duplicado IS
  'Triagem manual de suspeitas de pagamentos duplicados (indício objetivo: mesma referência bancária repetida). Não altera pagamentos.';

-- 2) Semeia SOMENTE os 6 grupos comprovados (exclui 50656430001 = título 65643,
--    legítimo). Data-driven: só insere se as duas linhas do grupo existirem.
--    A linha MAIOR (valor) vira sugestão de manter; a MENOR, sugestão de suspeita.
--    Parcela 50497270004 entra como "exige conferência manual" e SEM sugestão de
--    linha suspeita (os dois valores são altos e distintos).
WITH chaves(chave, manual) AS (
  VALUES
    ('50463730007', false),
    ('50497270004', true),
    ('50607630002', false),
    ('50646410001', false),
    ('50651650001', false),
    ('50660050001', false)
),
linhas AS (
  SELECT
    p.numero_parcela_completo AS chave,
    p.id AS pagamento_id,
    p.titulo_numero,
    p.valor_pago,
    row_number() OVER (PARTITION BY p.numero_parcela_completo ORDER BY p.valor_pago DESC, p.created_at ASC) AS rk,
    count(*) OVER (PARTITION BY p.numero_parcela_completo) AS n
  FROM public.pagamentos p
  JOIN chaves c ON c.chave = p.numero_parcela_completo
  WHERE p.retroativo = false
    AND p.valor_pago > 0
    AND NOT (COALESCE(p.dados,'{}'::jsonb) ? 'estornado_em')
),
grupo AS (
  SELECT
    l.chave,
    max(l.titulo_numero) AS titulo_numero,
    max(l.n) AS n,
    (array_agg(l.pagamento_id ORDER BY l.rk) FILTER (WHERE l.rk = 1))[1] AS maior_id,
    (array_agg(l.pagamento_id ORDER BY l.rk) FILTER (WHERE l.rk = 2))[1] AS menor_id
  FROM linhas l
  GROUP BY l.chave
)
INSERT INTO public.suspeitas_pagamento_duplicado (
  chave_grupo, titulo_numero, status, exige_conferencia_manual,
  pagamento_sugerido_manter_id, pagamento_sugerido_duplicado_id,
  origem_deteccao, detectado_em, ultima_deteccao_em
)
SELECT
  g.chave, g.titulo_numero, 'PENDENTE_VALIDACAO', c.manual,
  g.maior_id,
  CASE WHEN c.manual THEN NULL ELSE g.menor_id END,   -- parcela 2: sem sugestão visual
  'SEED', now(), now()
FROM grupo g
JOIN chaves c ON c.chave = g.chave
WHERE g.n >= 2 AND g.maior_id IS NOT NULL AND g.menor_id IS NOT NULL
ON CONFLICT (chave_grupo) DO NOTHING;

-- 3) Listagem para a aba (read-only). Retorna cada suspeita com as duas linhas
--    lado a lado (dados do pagamento + arquivo + status da importação).
CREATE OR REPLACE FUNCTION public.projecao_suspeitas_pagamentos_duplicados()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'titulo_numero')), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'id', s.id,
      'chave_grupo', s.chave_grupo,
      'titulo_numero', s.titulo_numero,
      'status', s.status,
      'exige_conferencia_manual', s.exige_conferencia_manual,
      'pagamento_sugerido_manter_id', s.pagamento_sugerido_manter_id,
      'pagamento_sugerido_duplicado_id', s.pagamento_sugerido_duplicado_id,
      'pagamento_manter_id', s.pagamento_manter_id,
      'pagamento_duplicado_id', s.pagamento_duplicado_id,
      'motivo', s.motivo,
      'decidido_por_email', s.decidido_por_email,
      'decidido_por_nome', s.decidido_por_nome,
      'decidido_em', s.decidido_em,
      'linhas', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'pagamento_id', p.id,
          'aluno_nome', p.aluno_nome,
          'numero_parcela_completo', p.numero_parcela_completo,
          'titulo_numero', p.titulo_numero,
          'valor_pago', p.valor_pago,
          'valor_honorario', p.valor_honorario,
          'data_pagamento', p.data_pagamento,
          'operador_nome', p.operador_nome,
          'operador_email', p.operador_email,
          'arquivo', i.arquivo_nome,
          'import_status', COALESCE(i.status, '(sem importacao)'),
          'sugerido_manter', (p.id = s.pagamento_sugerido_manter_id),
          'sugerido_duplicado', (p.id = s.pagamento_sugerido_duplicado_id)
        ) ORDER BY p.valor_pago DESC, p.created_at ASC), '[]'::jsonb)
        FROM public.pagamentos p
        LEFT JOIN public.importacoes i ON i.id = p.importacao_id
        WHERE p.numero_parcela_completo = s.chave_grupo
          AND p.retroativo = false AND p.valor_pago > 0
          AND NOT (COALESCE(p.dados,'{}'::jsonb) ? 'estornado_em')
      )
    ) x
    FROM public.suspeitas_pagamento_duplicado s
  ) t;
$function$;

-- 4) Registrar decisão manual. NÃO toca em pagamentos: só grava a triagem.
CREATE OR REPLACE FUNCTION public.registrar_decisao_suspeita_duplicidade(
  p_suspeita_id uuid,
  p_decisao text,
  p_pagamento_manter_id uuid,
  p_pagamento_duplicado_id uuid,
  p_motivo text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := lower(auth.email());
  v_nome text;
  s public.suspeitas_pagamento_duplicado%ROWTYPE;
BEGIN
  IF v_email NOT IN ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br', 'cobranca07@aelbra.com.br') THEN
    RAISE EXCEPTION 'Sem permissão para validar suspeitas de pagamento duplicado.';
  END IF;
  IF p_decisao NOT IN ('LEGITIMO','DUPLICIDADE_CONFIRMADA') THEN
    RAISE EXCEPTION 'Decisão inválida: %', p_decisao;
  END IF;
  IF COALESCE(btrim(p_motivo),'') = '' THEN
    RAISE EXCEPTION 'Motivo é obrigatório.';
  END IF;

  SELECT * INTO s FROM public.suspeitas_pagamento_duplicado WHERE id = p_suspeita_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Suspeita não encontrada.'; END IF;

  IF p_decisao = 'DUPLICIDADE_CONFIRMADA' THEN
    IF p_pagamento_manter_id IS NULL OR p_pagamento_duplicado_id IS NULL THEN
      RAISE EXCEPTION 'Informe qual linha manter e qual é a duplicada.';
    END IF;
    IF p_pagamento_manter_id = p_pagamento_duplicado_id THEN
      RAISE EXCEPTION 'A linha a manter e a duplicada não podem ser a mesma.';
    END IF;
    -- Ambas precisam pertencer ao grupo (mesma referência bancária).
    PERFORM 1 FROM public.pagamentos
      WHERE id = p_pagamento_manter_id AND numero_parcela_completo = s.chave_grupo;
    IF NOT FOUND THEN RAISE EXCEPTION 'Linha a manter não pertence a este grupo.'; END IF;
    PERFORM 1 FROM public.pagamentos
      WHERE id = p_pagamento_duplicado_id AND numero_parcela_completo = s.chave_grupo;
    IF NOT FOUND THEN RAISE EXCEPTION 'Linha duplicada não pertence a este grupo.'; END IF;
  END IF;

  SELECT registrado_por_nome INTO v_nome
  FROM public.aluno_movimentacoes WHERE registrado_por_email = v_email
  ORDER BY registrado_em DESC LIMIT 1;

  UPDATE public.suspeitas_pagamento_duplicado SET
    status = p_decisao,
    pagamento_manter_id   = CASE WHEN p_decisao='DUPLICIDADE_CONFIRMADA' THEN p_pagamento_manter_id ELSE NULL END,
    pagamento_duplicado_id= CASE WHEN p_decisao='DUPLICIDADE_CONFIRMADA' THEN p_pagamento_duplicado_id ELSE NULL END,
    motivo = p_motivo,
    decidido_por_email = v_email,
    decidido_por_nome = COALESCE(v_nome, v_email),
    decidido_em = now(),
    -- registra QUAIS linhas foram analisadas nesta decisão; uma linha NOVA
    -- (fora deste conjunto) é o que reabre o grupo depois.
    pagamentos_analisados = COALESCE((
      SELECT jsonb_agg(p.id::text)
      FROM public.pagamentos p
      WHERE p.numero_parcela_completo = s.chave_grupo
        AND p.retroativo = false AND COALESCE(p.valor_pago,0) > 0
        AND NOT (COALESCE(p.dados,'{}'::jsonb) ? 'estornado_em')
    ), '[]'::jsonb),
    atualizado_em = now()
  WHERE id = p_suspeita_id;

  INSERT INTO public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  VALUES (v_email, 'TRIAGEM_SUSPEITA_DUPLICIDADE', 'suspeitas_pagamento_duplicado', p_suspeita_id,
          jsonb_build_object('chave_grupo', s.chave_grupo, 'decisao', p_decisao,
                             'manter', p_pagamento_manter_id, 'duplicado', p_pagamento_duplicado_id,
                             'motivo', p_motivo));

  RETURN jsonb_build_object('ok', true, 'id', p_suspeita_id, 'status', p_decisao);
END;
$function$;

-- 5) REGRA PERMANENTE DE DETECÇÃO.
-- Trigger AFTER INSERT em pagamentos: quando a MESMA referência bancária
-- (numero_parcela_completo) passa a existir em mais de um pagamento objetivo,
-- cria/anexa/reabre o grupo na tabela de triagem. NÃO estorna, NÃO exclui,
-- NÃO altera valor, NÃO recalcula projeção/metas/ranking/honorários.
--
-- Só reage a INSERT real: reimportar a mesma linha cai no ON CONFLICT DO UPDATE
-- do importador (caminho UPDATE), que NÃO dispara este trigger AFTER INSERT ->
-- não cria grupo duplicado. A unicidade de grupo é garantida por uq_suspeita_chave.
CREATE OR REPLACE FUNCTION public.trg_detectar_suspeita_duplicidade()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_chave text := NEW.numero_parcela_completo;
  v_qtd integer;
  s public.suspeitas_pagamento_duplicado%ROWTYPE;
BEGIN
  -- Só repetição OBJETIVA de referência bancária. Ignora sem chave, retroativo,
  -- valor<=0 e linha já estornada. (Nada de nome/valor/data/operador.)
  IF v_chave IS NULL OR NEW.retroativo IS TRUE OR COALESCE(NEW.valor_pago,0) <= 0
     OR (COALESCE(NEW.dados,'{}'::jsonb) ? 'estornado_em') THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_qtd
  FROM public.pagamentos p
  WHERE p.numero_parcela_completo = v_chave
    AND p.retroativo = false AND COALESCE(p.valor_pago,0) > 0
    AND NOT (COALESCE(p.dados,'{}'::jsonb) ? 'estornado_em');

  IF v_qtd < 2 THEN
    RETURN NEW;  -- ainda não há repetição objetiva da referência
  END IF;

  SELECT * INTO s FROM public.suspeitas_pagamento_duplicado WHERE chave_grupo = v_chave;

  IF NOT FOUND THEN
    -- Sem análise anterior -> cria PENDENTE_VALIDACAO.
    INSERT INTO public.suspeitas_pagamento_duplicado
      (chave_grupo, titulo_numero, status, origem_deteccao, detectado_em, ultima_deteccao_em)
    VALUES (v_chave, NEW.titulo_numero, 'PENDENTE_VALIDACAO', 'TRIGGER_INSERT', now(), now())
    ON CONFLICT (chave_grupo) DO NOTHING;
    RETURN NEW;
  END IF;

  IF s.status = 'PENDENTE_VALIDACAO' THEN
    -- Já pendente: apenas anexa (registra nova detecção).
    UPDATE public.suspeitas_pagamento_duplicado
       SET ultima_deteccao_em = now(), atualizado_em = now()
     WHERE id = s.id;
  ELSE
    -- LEGITIMO ou DUPLICIDADE_CONFIRMADA: reabre SOMENTE se a linha nova ainda
    -- não foi analisada. Preserva a decisão anterior no histórico.
    IF NOT (COALESCE(s.pagamentos_analisados,'[]'::jsonb) ? NEW.id::text) THEN
      UPDATE public.suspeitas_pagamento_duplicado
         SET status = 'PENDENTE_VALIDACAO',
             historico_decisoes = COALESCE(historico_decisoes,'[]'::jsonb) || jsonb_build_object(
               'status', s.status, 'motivo', s.motivo,
               'pagamento_manter_id', s.pagamento_manter_id, 'pagamento_duplicado_id', s.pagamento_duplicado_id,
               'decidido_por_email', s.decidido_por_email, 'decidido_por_nome', s.decidido_por_nome,
               'decidido_em', s.decidido_em, 'reaberto_em', now(), 'reaberto_por_pagamento', NEW.id),
             motivo = NULL, pagamento_manter_id = NULL, pagamento_duplicado_id = NULL,
             decidido_por_email = NULL, decidido_por_nome = NULL, decidido_em = NULL,
             origem_deteccao = 'TRIGGER_INSERT_REABERTURA', ultima_deteccao_em = now(), atualizado_em = now()
       WHERE id = s.id;
    END IF;
    -- Se a linha já constava do conjunto analisado, não reabre (nada muda).
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS pagamentos_detectar_suspeita_dup ON public.pagamentos;
CREATE TRIGGER pagamentos_detectar_suspeita_dup
  AFTER INSERT ON public.pagamentos
  FOR EACH ROW EXECUTE FUNCTION public.trg_detectar_suspeita_duplicidade();

-- RLS: leitura para autenticados; escrita só via RPC SECURITY DEFINER.
ALTER TABLE public.suspeitas_pagamento_duplicado ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS suspeitas_dup_select ON public.suspeitas_pagamento_duplicado;
CREATE POLICY suspeitas_dup_select ON public.suspeitas_pagamento_duplicado
  FOR SELECT TO authenticated USING (true);

COMMIT;

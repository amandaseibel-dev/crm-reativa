-- WHATSAPP: CONTINUIDADE DE NEGOCIACAO E LIMITE 5 POR OPERADOR (30/10/2026)
--
-- SALVAR EM: supabase/migrations/20261030090000_whatsapp_cadencia_continuidade_e_limite_5.sql
--
-- O QUE ESTA MIGRATION FAZ, EM ORDEM:
--
--   1. whatsapp_config: adiciona `continuidade_janela_horas` (padrao 48).
--      Define janela (em horas) a partir do DIA da NOVA_ABORDAGEM original
--      dentro da qual re-envios do mesmo operador para a mesma conversa sao
--      classificados como CONTINUIDADE (isento de cota).
--      A janela e ancorada no registro em whatsapp_abordagens -- ela nao se
--      renova por envios sucessivos de CONTINUIDADE, porque CONTINUIDADE retorna
--      antes do INSERT naquela tabela.
--
--   2. teto_abordagens_operador: 3 -> 5.
--      Sobe o freio global para que o limite do canal possa ser gravado
--      pela porta legitima (whatsapp_canal_cadencia_salvar). Sem este passo,
--      gravar 5 em `limite_abordagens_operador` falharia com TETO_ABORDAGENS_OPERADOR.
--
--   3. whatsapp_canais (Comercial): limite_abordagens_operador 2 -> 5.
--      limite_abordagens_canal (NULL) permanece sem teto — manter abre o canal
--      para medir bloqueios reais antes de definir um numero.
--
--   4. whatsapp_cadencia_bloqueios: adiciona INTERVALO_MINIMO a constraint de motivo.
--      O motivo ja era levantado pela cadencia desde 25/08/2026, mas a constraint
--      antiga nao o aceitava — entao o log falhava em silencio (alem do bug do
--      .catch, corrigido na Edge Function whatsapp-send neste mesmo branch).
--
--   5. whatsapp_cadencia_checar: nova classificacao CONTINUIDADE inserida
--      apos FORA_DA_JANELA, antes do INSERT de abordagem.
--
--      Hierarquia de classificacao:
--        RESPOSTA       — aluno escreveu nas ultimas resposta_janela_horas h (24h)
--        CONTINUIDADE   — existe abordagem do operador nesta conversa ha no maximo
--                         floor(continuidade_janela_horas / 24) dias (padrao 2 dias)
--        NOVA_ABORDAGEM — nenhum dos dois; conta na cota diaria
--
--      CONTINUIDADE fica apos SOMENTE_RESPOSTAS e FORA_DA_JANELA: restricoes do
--      canal prevalecem sobre continuidade.
--
-- O QUE NAO MUDA, DE PROPOSITO:
--   * intervalo minimo de 60 s entre alunos distintos
--   * janela 08:00-20:00 do Comercial
--   * RESPOSTA (24 h) nao e alterada
--   * Piloto: nenhuma coluna tocada
--   * limite de canal (NULL) do Comercial permanece sem teto
--   * whatsapp_cadencia_liberacoes e whatsapp_cadencia_consumo sem alteracao
--
-- IDEMPOTENTE E FALHA FECHADO: aceita estado inicial (3/2) ou alvo (5/5).
-- Qualquer outro valor aborta sem gravar nada.
--
-- APLICACAO: ver docs/RUNBOOK-MIGRATIONS.md. Rollback versionado ao lado.

-- ============================================================
-- 1. continuidade_janela_horas em whatsapp_config
-- ============================================================
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS continuidade_janela_horas integer NOT NULL DEFAULT 48;

ALTER TABLE public.whatsapp_config
  DROP CONSTRAINT IF EXISTS ck_whatsapp_config_continuidade_janela;
ALTER TABLE public.whatsapp_config
  ADD CONSTRAINT ck_whatsapp_config_continuidade_janela
  CHECK (continuidade_janela_horas >= 0);

COMMENT ON COLUMN public.whatsapp_config.continuidade_janela_horas IS
  'Janela em horas a partir do dia da NOVA_ABORDAGEM original dentro da qual re-envios do mesmo operador sao CONTINUIDADE (isento de cota). 0 desliga. Convertido para dias inteiros (floor(n/24)) ao consultar whatsapp_abordagens.dia. Padrao 48.';

-- ============================================================
-- 2 + 3. teto 3 -> 5 e Comercial operador 2 -> 5
-- ============================================================
DO $$
DECLARE
  v_teto     integer;
  v_op_atual integer;
  v_linhas   integer;
BEGIN
  SELECT teto_abordagens_operador INTO v_teto FROM public.whatsapp_config LIMIT 1;
  IF v_teto IS NULL THEN
    RAISE EXCEPTION 'whatsapp_config sem linha: nao ha teto para avaliar'
      USING ERRCODE = '42704';
  END IF;

  SELECT limite_abordagens_operador INTO v_op_atual
    FROM public.whatsapp_canais WHERE sessao_chave = 'comercial';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canal comercial nao encontrado em whatsapp_canais'
      USING ERRCODE = '42704';
  END IF;

  IF v_teto = 5 AND v_op_atual = 5 THEN
    RAISE NOTICE 'teto 5, Comercial 5 — nada a fazer'; RETURN;
  END IF;

  IF v_teto IS DISTINCT FROM 3 OR v_op_atual IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION
      'estado inesperado: teto=% operador=% (esperado 3/2 ou 5/5)',
      v_teto, COALESCE(v_op_atual::text, 'NULL')
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.whatsapp_config SET teto_abordagens_operador = 5;
  GET DIAGNOSTICS v_linhas = ROW_COUNT;
  IF v_linhas <> 1 THEN
    RAISE EXCEPTION 'esperava 1 linha em whatsapp_config, atualizou %', v_linhas
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.whatsapp_canais
     SET limite_abordagens_operador = 5
   WHERE sessao_chave = 'comercial';
  GET DIAGNOSTICS v_linhas = ROW_COUNT;
  IF v_linhas <> 1 THEN
    RAISE EXCEPTION 'esperava atualizar 1 canal, atualizou %', v_linhas
      USING ERRCODE = '22023';
  END IF;

  RAISE NOTICE 'teto 3 -> 5; Comercial: operador 2 -> 5';
END $$;

-- ============================================================
-- 4. INTERVALO_MINIMO na constraint de motivo dos bloqueios
-- ============================================================
ALTER TABLE public.whatsapp_cadencia_bloqueios
  DROP CONSTRAINT IF EXISTS ck_whatsapp_bloqueio_motivo;
ALTER TABLE public.whatsapp_cadencia_bloqueios
  ADD CONSTRAINT ck_whatsapp_bloqueio_motivo CHECK (motivo IN (
    'MODO_PAUSADO', 'MODO_SOMENTE_RESPOSTAS', 'FORA_DA_JANELA',
    'LIMITE_OPERADOR', 'LIMITE_CANAL', 'INTERVALO_MINIMO'));

-- ============================================================
-- 5. whatsapp_cadencia_checar: adiciona CONTINUIDADE
-- ============================================================
CREATE OR REPLACE FUNCTION public.whatsapp_cadencia_checar(
  p_canal_id    uuid,
  p_conversa_id uuid,
  p_operador    text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_canal          public.whatsapp_canais%ROWTYPE;
  v_agora          timestamptz := now();
  v_hoje           date        := (v_agora AT TIME ZONE 'America/Sao_Paulo')::date;
  v_hora           time        := (v_agora AT TIME ZONE 'America/Sao_Paulo')::time;
  v_resposta       boolean;
  v_continuidade   boolean;
  v_op             integer;
  v_ch             integer;
  v_extra          integer := 0;
  v_limite_op      integer;
  v_intervalo      integer;
  v_janela_h       integer;
  v_continuidade_h integer;
  v_ultimo         timestamptz;
  v_faltam         integer;
BEGIN
  SELECT * INTO v_canal FROM public.whatsapp_canais WHERE id = p_canal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'canal inexistente'; END IF;

  IF v_canal.modo = 'PAUSADO' THEN
    RAISE EXCEPTION 'o numero % esta pausado: nenhuma mensagem sai por ele', v_canal.apelido
      USING ERRCODE = '42501', DETAIL = 'MODO_PAUSADO';
  END IF;

  SELECT COALESCE(intervalo_minimo_envio_seg, 60),
         COALESCE(resposta_janela_horas, 24),
         COALESCE(continuidade_janela_horas, 48)
    INTO v_intervalo, v_janela_h, v_continuidade_h
    FROM public.whatsapp_config LIMIT 1;
  v_intervalo      := COALESCE(v_intervalo, 60);
  v_janela_h       := COALESCE(v_janela_h, 24);
  v_continuidade_h := COALESCE(v_continuidade_h, 48);

  -- RITMO: vale para abordagem E resposta, porque o WhatsApp olha o
  -- ritmo do numero, nao a nossa classificacao. Mesma conversa nao conta.
  IF v_intervalo > 0 THEN
    SELECT max(m.criado_em) INTO v_ultimo
      FROM public.whatsapp_mensagens m
      JOIN public.whatsapp_conversas cv ON cv.id = m.conversa_id
     WHERE m.direcao = 'SAIDA'
       AND lower(m.enviado_por_email) = lower(p_operador)
       AND cv.canal_id = p_canal_id
       AND m.conversa_id IS DISTINCT FROM p_conversa_id
       AND m.criado_em > v_agora - make_interval(secs => v_intervalo);

    IF v_ultimo IS NOT NULL THEN
      v_faltam := ceil(extract(epoch from (v_ultimo + make_interval(secs => v_intervalo) - v_agora)));
      RAISE EXCEPTION 'espere % segundos antes de falar com outro aluno neste numero', GREATEST(v_faltam, 1)
        USING ERRCODE = '42501', DETAIL = 'INTERVALO_MINIMO';
    END IF;
  END IF;

  -- RESPOSTA: aluno escreveu nas ultimas v_janela_h horas
  v_resposta := p_conversa_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.whatsapp_mensagens m
    WHERE m.conversa_id = p_conversa_id
      AND m.direcao = 'ENTRADA'
      AND m.timestamp_wa >= v_agora - make_interval(hours => v_janela_h)
  );
  IF v_resposta THEN RETURN 'RESPOSTA'; END IF;

  -- Restricoes do canal prevalecem sobre continuidade.
  IF v_canal.modo = 'SOMENTE_RESPOSTAS' THEN
    RAISE EXCEPTION 'o numero % so responde quem escreveu nas ultimas %h', v_canal.apelido, v_janela_h
      USING ERRCODE = '42501', DETAIL = 'MODO_SOMENTE_RESPOSTAS';
  END IF;

  IF v_canal.janela_inicio IS NOT NULL AND v_canal.janela_fim IS NOT NULL
     AND (v_hora < v_canal.janela_inicio OR v_hora >= v_canal.janela_fim) THEN
    RAISE EXCEPTION 'novas conversas so entre % e %, horario de Brasilia',
      to_char(v_canal.janela_inicio, 'HH24:MI'), to_char(v_canal.janela_fim, 'HH24:MI')
      USING ERRCODE = '42501', DETAIL = 'FORA_DA_JANELA';
  END IF;

  -- CONTINUIDADE: ja existe abordagem registrada para esta conversa e este operador
  -- dentro de floor(continuidade_janela_horas / 24) dias. Como CONTINUIDADE retorna
  -- antes do INSERT em whatsapp_abordagens, nenhum envio de continuidade cria novo
  -- registro -- a janela e ancorada no primeiro contato e nao pode ser renovada por
  -- envios sucessivos.
  IF v_continuidade_h > 0 AND p_conversa_id IS NOT NULL THEN
    v_continuidade := EXISTS (
      SELECT 1 FROM public.whatsapp_abordagens a
      WHERE a.canal_id = p_canal_id
        AND a.conversa_id = p_conversa_id
        AND a.operador_email = lower(p_operador)
        AND a.dia >= v_hoje - (v_continuidade_h / 24)
    );
    IF v_continuidade THEN RETURN 'CONTINUIDADE'; END IF;
  END IF;

  INSERT INTO public.whatsapp_abordagens (canal_id, conversa_id, operador_email, dia)
  VALUES (p_canal_id, p_conversa_id, lower(p_operador), v_hoje)
  ON CONFLICT (canal_id, conversa_id, dia) DO NOTHING;

  SELECT count(*) INTO v_op FROM public.whatsapp_abordagens
   WHERE canal_id = p_canal_id AND operador_email = lower(p_operador) AND dia = v_hoje;
  SELECT count(*) INTO v_ch FROM public.whatsapp_abordagens
   WHERE canal_id = p_canal_id AND dia = v_hoje;

  SELECT COALESCE(l.extra, 0) INTO v_extra FROM public.whatsapp_cadencia_liberacoes l
   WHERE l.canal_id = p_canal_id AND l.operador_email = lower(p_operador) AND l.dia = v_hoje;
  v_extra := COALESCE(v_extra, 0);
  v_limite_op := v_canal.limite_abordagens_operador + v_extra;

  IF v_canal.limite_abordagens_operador IS NOT NULL
     AND v_op > v_limite_op THEN
    RAISE EXCEPTION 'voce ja iniciou % conversas novas hoje neste numero. Responder quem escreveu nas ultimas %h continua liberado',
      v_limite_op, v_janela_h
      USING ERRCODE = '42501', DETAIL = 'LIMITE_OPERADOR';
  END IF;

  IF v_canal.limite_abordagens_canal IS NOT NULL
     AND v_ch > v_canal.limite_abordagens_canal THEN
    RAISE EXCEPTION 'o numero % ja iniciou % conversas novas hoje. Nenhum operador inicia novas ate amanha',
      v_canal.apelido, v_canal.limite_abordagens_canal
      USING ERRCODE = '42501', DETAIL = 'LIMITE_CANAL';
  END IF;

  RETURN 'NOVA_ABORDAGEM';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.whatsapp_cadencia_checar(uuid, uuid, text)
  TO authenticated;

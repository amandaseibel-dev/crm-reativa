-- Fecha os dois furos que a manha de 25/08 expos, com o Piloto recem-liberado.
--
-- O QUE ACONTECEU: a Olga (cobranca03) mandou para 5 alunos em 3 minutos e o
-- sistema contou UMA abordagem. Nao foi bug: "resposta" era qualquer conversa
-- com ENTRADA nos ultimos 30 DIAS, e resposta nao gasta cota. Com isso o teto
-- de 3 quase nao existia — a base inteira que ja escreveu alguma vez ficava
-- liberada. Um dos casos tinha entrada de 4,7 dias atras e passou como resposta.
--
-- FURO 1 — o que conta como resposta. 30 dias vira 24 HORAS. E a mesma ideia da
-- janela de atendimento da API oficial: quem escreveu ontem a tarde ainda esta
-- conversando; quem escreveu semana passada e abordagem nova.
--
-- FURO 2 — o RITMO. A cota limitava quanto por dia, nunca a velocidade. Cinco
-- envios em 3 minutos e a assinatura exata do lote que banniu o numero em
-- 21/08. Agora exige intervalo entre envios a alunos DIFERENTES; mensagens
-- seguidas na MESMA conversa continuam livres (mandar PDF + explicacao e um
-- atendimento so, nao uma rajada).

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS intervalo_minimo_envio_seg integer NOT NULL DEFAULT 60;

ALTER TABLE public.whatsapp_config
  DROP CONSTRAINT IF EXISTS ck_whatsapp_config_intervalo;
ALTER TABLE public.whatsapp_config
  ADD CONSTRAINT ck_whatsapp_config_intervalo
  CHECK (intervalo_minimo_envio_seg >= 0);

COMMENT ON COLUMN public.whatsapp_config.intervalo_minimo_envio_seg IS
  'Segundos minimos entre envios do MESMO operador para alunos DIFERENTES no mesmo canal. 0 desliga.';

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS resposta_janela_horas integer NOT NULL DEFAULT 24;

ALTER TABLE public.whatsapp_config
  DROP CONSTRAINT IF EXISTS ck_whatsapp_config_resposta_janela;
ALTER TABLE public.whatsapp_config
  ADD CONSTRAINT ck_whatsapp_config_resposta_janela
  CHECK (resposta_janela_horas > 0);

COMMENT ON COLUMN public.whatsapp_config.resposta_janela_horas IS
  'Ha quantas horas o aluno precisa ter escrito para o envio contar como resposta (livre). Fora disso e abordagem e gasta cota.';

-- O indice que falta: a checagem de intervalo roda em TODO envio e sem ele
-- varre as 44 mil mensagens. Parcial em SAIDA porque so a saida interessa.
CREATE INDEX IF NOT EXISTS ix_whatsapp_mensagens_remetente
  ON public.whatsapp_mensagens (lower(enviado_por_email), criado_em DESC)
  WHERE direcao = 'SAIDA';

CREATE OR REPLACE FUNCTION public.whatsapp_cadencia_checar(
  p_canal_id uuid,
  p_conversa_id uuid,
  p_operador text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_canal   public.whatsapp_canais%ROWTYPE;
  v_agora   timestamptz := now();
  v_hoje    date := (v_agora AT TIME ZONE 'America/Sao_Paulo')::date;
  v_hora    time := (v_agora AT TIME ZONE 'America/Sao_Paulo')::time;
  v_resposta boolean;
  v_op      integer;
  v_ch      integer;
  v_extra   integer := 0;
  v_limite_op integer;
  v_intervalo integer;
  v_janela_h  integer;
  v_ultimo    timestamptz;
  v_faltam    integer;
BEGIN
  SELECT * INTO v_canal FROM public.whatsapp_canais WHERE id = p_canal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'canal inexistente'; END IF;

  IF v_canal.modo = 'PAUSADO' THEN
    RAISE EXCEPTION 'o numero % esta pausado: nenhuma mensagem sai por ele', v_canal.apelido
      USING ERRCODE = '42501', DETAIL = 'MODO_PAUSADO';
  END IF;

  SELECT COALESCE(intervalo_minimo_envio_seg, 60), COALESCE(resposta_janela_horas, 24)
    INTO v_intervalo, v_janela_h
    FROM public.whatsapp_config LIMIT 1;
  v_intervalo := COALESCE(v_intervalo, 60);
  v_janela_h  := COALESCE(v_janela_h, 24);

  -- RITMO: vale para abordagem E para resposta, porque o WhatsApp olha o
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

  -- RESPOSTA: agora e janela curta (24h por padrao), nao 30 dias.
  v_resposta := p_conversa_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.whatsapp_mensagens m
    WHERE m.conversa_id = p_conversa_id
      AND m.direcao = 'ENTRADA'
      AND m.timestamp_wa >= v_agora - make_interval(hours => v_janela_h)
  );

  IF v_resposta THEN
    RETURN 'RESPOSTA';
  END IF;

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

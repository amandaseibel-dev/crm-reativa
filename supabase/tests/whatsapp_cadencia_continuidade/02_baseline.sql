-- BASELINE — versão ATUAL de whatsapp_cadencia_checar (sem CONTINUIDADE).
--
-- Esta é a função que está em produção imediatamente ANTES da migration
-- 20261030090000. O CI aplica a migration por cima, e os casos testam o
-- resultado — não a baseline. Este arquivo existe para que o CI reproduza
-- o estado real de partida.

\set ON_ERROR_STOP on

-- Canal Comercial com limite operador=2 (estado pré-migration)
insert into public.whatsapp_canais (
  sessao_chave, display_phone_number, apelido, ativo, conexao_status,
  modo, janela_inicio, janela_fim, limite_abordagens_operador, limite_abordagens_canal)
values ('comercial', '+55 51 9000-0001', 'Comercial', true, 'CONECTADO',
        'ATIVO_CONTROLADO', '08:00', '20:00', 2, null);

-- Função baseline: sem CONTINUIDADE, sem v_continuidade_h
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
  v_op             integer;
  v_ch             integer;
  v_extra          integer := 0;
  v_limite_op      integer;
  v_intervalo      integer;
  v_janela_h       integer;
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
         COALESCE(resposta_janela_horas, 24)
    INTO v_intervalo, v_janela_h
    FROM public.whatsapp_config LIMIT 1;
  v_intervalo := COALESCE(v_intervalo, 60);
  v_janela_h  := COALESCE(v_janela_h, 24);

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

  v_resposta := p_conversa_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.whatsapp_mensagens m
    WHERE m.conversa_id = p_conversa_id
      AND m.direcao = 'ENTRADA'
      AND m.timestamp_wa >= v_agora - make_interval(hours => v_janela_h)
  );
  IF v_resposta THEN RETURN 'RESPOSTA'; END IF;

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

GRANT EXECUTE ON FUNCTION public.whatsapp_cadencia_checar(uuid, uuid, text) TO authenticated;

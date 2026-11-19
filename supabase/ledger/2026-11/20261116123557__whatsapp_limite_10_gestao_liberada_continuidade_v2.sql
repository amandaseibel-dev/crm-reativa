DO $guarda$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'whatsapp_cadencia_checar')
     IS DISTINCT FROM 'da5cc8a08ccb006e87cc19ff1ff710be' THEN
    RAISE EXCEPTION 'whatsapp_cadencia_checar mudou desde a leitura de 16/11: reler antes de aplicar';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'whatsapp_cadencia_consumo')
     IS DISTINCT FROM '95f821952a2f50d73f3f6946cee4de48' THEN
    RAISE EXCEPTION 'whatsapp_cadencia_consumo mudou desde a leitura de 16/11: reler antes de aplicar';
  END IF;
END $guarda$;

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS continuidade_janela_horas integer NOT NULL DEFAULT 72;
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS continuidade_max_sem_resposta integer NOT NULL DEFAULT 3;

ALTER TABLE public.whatsapp_config DROP CONSTRAINT IF EXISTS ck_whatsapp_config_continuidade_janela;
ALTER TABLE public.whatsapp_config ADD CONSTRAINT ck_whatsapp_config_continuidade_janela
  CHECK (continuidade_janela_horas >= 0);
ALTER TABLE public.whatsapp_config DROP CONSTRAINT IF EXISTS ck_whatsapp_config_continuidade_max;
ALTER TABLE public.whatsapp_config ADD CONSTRAINT ck_whatsapp_config_continuidade_max
  CHECK (continuidade_max_sem_resposta >= 0);

ALTER TABLE public.whatsapp_cadencia_bloqueios DROP CONSTRAINT IF EXISTS ck_whatsapp_bloqueio_motivo;
ALTER TABLE public.whatsapp_cadencia_bloqueios ADD CONSTRAINT ck_whatsapp_bloqueio_motivo CHECK (motivo IN (
  'MODO_PAUSADO', 'MODO_SOMENTE_RESPOSTAS', 'FORA_DA_JANELA',
  'LIMITE_OPERADOR', 'LIMITE_CANAL', 'INTERVALO_MINIMO'));

UPDATE public.whatsapp_config SET teto_abordagens_operador = 10;

UPDATE public.whatsapp_canais
   SET limite_abordagens_operador = 10
 WHERE id = 'b8f00c75-aee3-4d22-83b7-f0041be0ef71';

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
  v_cont_h         integer;
  v_cont_max       integer;
  v_ultimo         timestamptz;
  v_faltam         integer;
  v_ult_entrada    timestamptz;
  v_tem_saida_dele boolean;
  v_sem_resposta   integer;
  v_conv_bloqueada boolean;
  v_liberado       boolean;
BEGIN
  SELECT * INTO v_canal FROM public.whatsapp_canais WHERE id = p_canal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'canal inexistente'; END IF;

  IF v_canal.modo = 'PAUSADO' THEN
    RAISE EXCEPTION 'o numero % esta pausado: nenhuma mensagem sai por ele', v_canal.apelido
      USING ERRCODE = '42501', DETAIL = 'MODO_PAUSADO';
  END IF;

  SELECT COALESCE(intervalo_minimo_envio_seg, 60),
         COALESCE(resposta_janela_horas, 24),
         COALESCE(continuidade_janela_horas, 72),
         COALESCE(continuidade_max_sem_resposta, 3)
    INTO v_intervalo, v_janela_h, v_cont_h, v_cont_max
    FROM public.whatsapp_config LIMIT 1;
  v_intervalo := COALESCE(v_intervalo, 60);
  v_janela_h  := COALESCE(v_janela_h, 24);
  v_cont_h    := COALESCE(v_cont_h, 72);
  v_cont_max  := COALESCE(v_cont_max, 3);

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

  -- CONTINUIDADE v2: cinco condicoes, nenhuma renovavel pelo operador.
  IF v_cont_h > 0 AND v_cont_max > 0 AND p_conversa_id IS NOT NULL THEN
    SELECT (cv.arquivada_em IS NOT NULL OR cv.status = 'ENCERRADO')
      INTO v_conv_bloqueada
      FROM public.whatsapp_conversas cv
     WHERE cv.id = p_conversa_id;

    IF COALESCE(v_conv_bloqueada, true) = false THEN
      SELECT EXISTS (
        SELECT 1 FROM public.whatsapp_mensagens m
        WHERE m.conversa_id = p_conversa_id
          AND m.direcao = 'SAIDA'
          AND lower(m.enviado_por_email) = lower(p_operador)
      ) INTO v_tem_saida_dele;

      SELECT max(m.timestamp_wa) INTO v_ult_entrada
        FROM public.whatsapp_mensagens m
       WHERE m.conversa_id = p_conversa_id
         AND m.direcao = 'ENTRADA';

      IF v_tem_saida_dele
         AND v_ult_entrada IS NOT NULL
         AND v_ult_entrada >= v_agora - make_interval(hours => v_cont_h)
      THEN
        SELECT count(*) INTO v_sem_resposta
          FROM public.whatsapp_mensagens m
         WHERE m.conversa_id = p_conversa_id
           AND m.direcao = 'SAIDA'
           AND lower(m.enviado_por_email) = lower(p_operador)
           AND m.criado_em > v_ult_entrada;

        IF v_sem_resposta < v_cont_max THEN
          RETURN 'CONTINUIDADE';
        END IF;
      END IF;
    END IF;
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

  -- Gerencia, supervisao e administrativo nao tem limite proprio.
  -- A abordagem deles segue registrada e segue contando no teto do NUMERO.
  v_liberado := EXISTS (
    SELECT 1 FROM public.usuarios u
     WHERE lower(u.email) = lower(p_operador)
       AND u.ativo
       AND u.perfil IN ('gerencia', 'supervisor', 'administrativo'));

  IF NOT v_liberado
     AND v_canal.limite_abordagens_operador IS NOT NULL
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

REVOKE ALL ON FUNCTION public.whatsapp_cadencia_checar(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.whatsapp_cadencia_checar(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.whatsapp_cadencia_checar(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_cadencia_checar(uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.whatsapp_cadencia_consumo()
 RETURNS TABLE(canal_id uuid, canal_apelido text, modo text, limite_operador integer, usadas_operador integer, limite_canal integer, usadas_canal integer, janela_inicio time without time zone, janela_fim time without time zone, dentro_da_janela boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH agora AS (
    SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje,
           (now() AT TIME ZONE 'America/Sao_Paulo')::time AS hora
  )
  SELECT k.id, k.apelido, k.modo,
         CASE WHEN k.limite_abordagens_operador IS NULL
                OR EXISTS (SELECT 1 FROM public.usuarios u
                            WHERE lower(u.email) = lower(public.app_email())
                              AND u.ativo
                              AND u.perfil IN ('gerencia', 'supervisor', 'administrativo'))
              THEN NULL
              ELSE k.limite_abordagens_operador + COALESCE((
                SELECT l.extra FROM public.whatsapp_cadencia_liberacoes l, agora g
                 WHERE l.canal_id = k.id AND l.dia = g.hoje
                   AND l.operador_email = lower(public.app_email())), 0)
         END,
         (SELECT count(*)::integer FROM public.whatsapp_abordagens a, agora g
           WHERE a.canal_id = k.id AND a.dia = g.hoje
             AND a.operador_email = public.app_email()),
         k.limite_abordagens_canal,
         (SELECT count(*)::integer FROM public.whatsapp_abordagens a, agora g
           WHERE a.canal_id = k.id AND a.dia = g.hoje),
         k.janela_inicio, k.janela_fim,
         (SELECT k.janela_inicio IS NULL OR k.janela_fim IS NULL
                 OR (g.hora >= k.janela_inicio AND g.hora < k.janela_fim) FROM agora g)
  FROM public.whatsapp_canais k
  WHERE public.app_usuario_ativo() AND k.ativo
  ORDER BY k.apelido;
$function$;

REVOKE ALL ON FUNCTION public.whatsapp_cadencia_consumo() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.whatsapp_cadencia_consumo() FROM anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_cadencia_consumo() TO authenticated, service_role;

DO $verifica$
DECLARE v_lim integer; v_teto integer; v_resp integer; v_src text;
BEGIN
  SELECT limite_abordagens_operador INTO v_lim FROM public.whatsapp_canais
   WHERE id = 'b8f00c75-aee3-4d22-83b7-f0041be0ef71';
  SELECT teto_abordagens_operador, resposta_janela_horas INTO v_teto, v_resp
    FROM public.whatsapp_config LIMIT 1;
  IF v_lim IS DISTINCT FROM 10 OR v_teto IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'limite/teto nao ficaram em 10 (canal %, teto %)', v_lim, v_teto;
  END IF;
  IF v_resp IS DISTINCT FROM 24 THEN
    RAISE EXCEPTION 'resposta_janela_horas deveria seguir 24 e esta %', v_resp;
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'whatsapp_cadencia_checar';
  IF v_src NOT ILIKE '%CONTINUIDADE%' OR v_src NOT ILIKE '%v_liberado%' THEN
    RAISE EXCEPTION 'whatsapp_cadencia_checar sem CONTINUIDADE ou sem liberacao de gestao';
  END IF;

  IF has_function_privilege('authenticated', 'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.whatsapp_cadencia_consumo()', 'EXECUTE') THEN
    RAISE EXCEPTION 'grant indevido em funcao de cadencia' USING ERRCODE = '42501';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.whatsapp_cadencia_consumo()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated perdeu EXECUTE em whatsapp_cadencia_consumo';
  END IF;
END $verifica$;

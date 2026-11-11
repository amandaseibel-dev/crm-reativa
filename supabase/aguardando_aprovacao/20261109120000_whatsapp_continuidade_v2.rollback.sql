-- =====================================================================
-- ROLLBACK de 20261109120000_whatsapp_continuidade_v2
--
-- Devolve whatsapp_cadencia_checar ao corpo que estava vivo em produção
-- em 09/11/2026 (sem CONTINUIDADE) e remove os dois parâmetros novos.
--
-- O corpo abaixo foi lido de pg_get_functiondef na produção
-- (ahattpqrjmhkzsmnbdzs) em 09/11/2026, não reconstruído de memória.
--
-- NÃO toca: resposta_janela_horas (24), limite_abordagens_operador (2),
-- teto_abordagens_operador (3), limite_abordagens_canal (60), janela
-- 08:00-20:00, intervalo 60s, cotas em whatsapp_cadencia_liberacoes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Função de volta ao corpo anterior (sem CONTINUIDADE)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_cadencia_checar(
  p_canal_id    uuid,
  p_conversa_id uuid,
  p_operador    text)
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

REVOKE ALL ON FUNCTION public.whatsapp_cadencia_checar(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.whatsapp_cadencia_checar(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.whatsapp_cadencia_checar(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_cadencia_checar(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------
-- 2. Remove os parâmetros novos
-- ---------------------------------------------------------------------
ALTER TABLE public.whatsapp_config DROP CONSTRAINT IF EXISTS ck_whatsapp_config_continuidade_janela;
ALTER TABLE public.whatsapp_config DROP CONSTRAINT IF EXISTS ck_whatsapp_config_continuidade_max;
ALTER TABLE public.whatsapp_config DROP COLUMN IF EXISTS continuidade_janela_horas;
ALTER TABLE public.whatsapp_config DROP COLUMN IF EXISTS continuidade_max_sem_resposta;

-- ---------------------------------------------------------------------
-- 3. Constraint de motivo dos bloqueios
--    Só estreita de volta se nenhuma linha usar INTERVALO_MINIMO.
--    Constraint mais larga é inofensiva; apagar histórico de bloqueio não é.
-- ---------------------------------------------------------------------
DO $motivo$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.whatsapp_cadencia_bloqueios
   WHERE motivo = 'INTERVALO_MINIMO';

  IF v_n = 0 THEN
    ALTER TABLE public.whatsapp_cadencia_bloqueios
      DROP CONSTRAINT IF EXISTS ck_whatsapp_bloqueio_motivo;
    ALTER TABLE public.whatsapp_cadencia_bloqueios
      ADD CONSTRAINT ck_whatsapp_bloqueio_motivo CHECK (motivo IN (
        'MODO_PAUSADO', 'MODO_SOMENTE_RESPOSTAS', 'FORA_DA_JANELA',
        'LIMITE_OPERADOR', 'LIMITE_CANAL'));
    RAISE NOTICE 'constraint de motivo estreitada de volta';
  ELSE
    RAISE NOTICE 'MANTIDA a constraint larga: % linhas usam INTERVALO_MINIMO e nao serao apagadas', v_n;
  END IF;
END $motivo$;

-- ---------------------------------------------------------------------
-- 4. Conferência
-- ---------------------------------------------------------------------
DO $verifica$
DECLARE v_tem boolean; v_resp integer;
BEGIN
  SELECT prosrc ILIKE '%CONTINUIDADE%' INTO v_tem
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'whatsapp_cadencia_checar';
  IF COALESCE(v_tem, false) THEN
    RAISE EXCEPTION 'rollback falhou: funcao ainda contem CONTINUIDADE' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='whatsapp_config'
                AND column_name IN ('continuidade_janela_horas','continuidade_max_sem_resposta')) THEN
    RAISE EXCEPTION 'rollback falhou: colunas de continuidade ainda existem' USING ERRCODE = '22023';
  END IF;

  SELECT resposta_janela_horas INTO v_resp FROM public.whatsapp_config LIMIT 1;
  IF v_resp IS DISTINCT FROM 24 THEN
    RAISE EXCEPTION 'resposta_janela_horas deveria ser 24 e esta %', v_resp USING ERRCODE = '22023';
  END IF;

  IF has_function_privilege('authenticated',
        'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated ganhou EXECUTE no rollback (proibido)' USING ERRCODE = '42501';
  END IF;

  RAISE NOTICE 'rollback concluido: funcao sem CONTINUIDADE, parametros removidos';
END $verifica$;

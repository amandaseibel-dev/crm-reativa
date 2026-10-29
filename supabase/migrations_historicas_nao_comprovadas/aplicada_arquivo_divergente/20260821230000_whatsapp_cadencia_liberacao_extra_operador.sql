-- Liberacao extra de abordagens por operador/dia/canal.
-- O limite do canal (limite_abordagens_operador) continua valendo para todos;
-- a gestao concede um "extra" pontual a UM operador para UM dia, sem mexer na
-- regra geral. O teto do canal (limite_abordagens_canal) NAO e afetado.

CREATE TABLE IF NOT EXISTS public.whatsapp_cadencia_liberacoes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canal_id       uuid NOT NULL REFERENCES public.whatsapp_canais(id) ON DELETE CASCADE,
  operador_email text NOT NULL,
  dia            date NOT NULL,
  extra          integer NOT NULL CHECK (extra > 0),
  concedido_por  text,
  motivo         text,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_whatsapp_cadencia_liberacao UNIQUE (canal_id, operador_email, dia)
);
ALTER TABLE public.whatsapp_cadencia_liberacoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_cadencia_liberacoes FROM public, anon, authenticated;

-- Gestao concede (soma ao extra ja existente no dia).
CREATE OR REPLACE FUNCTION public.whatsapp_cadencia_liberar_extra(
  p_canal_id uuid, p_operador text, p_extra integer, p_motivo text DEFAULT NULL, p_dia date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_dia date := COALESCE(p_dia, (now() AT TIME ZONE 'America/Sao_Paulo')::date);
  v_total integer;
BEGIN
  IF NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'somente gestao libera cota extra' USING ERRCODE = '42501';
  END IF;
  IF p_extra IS NULL OR p_extra <= 0 THEN
    RAISE EXCEPTION 'extra precisa ser maior que zero';
  END IF;
  INSERT INTO public.whatsapp_cadencia_liberacoes (canal_id, operador_email, dia, extra, concedido_por, motivo)
  VALUES (p_canal_id, lower(p_operador), v_dia, p_extra, lower(auth.jwt() ->> 'email'), p_motivo)
  ON CONFLICT (canal_id, operador_email, dia)
  DO UPDATE SET extra = public.whatsapp_cadencia_liberacoes.extra + EXCLUDED.extra,
                concedido_por = EXCLUDED.concedido_por,
                motivo = COALESCE(EXCLUDED.motivo, public.whatsapp_cadencia_liberacoes.motivo)
  RETURNING extra INTO v_total;
  RETURN v_total;
END;
$function$;
REVOKE ALL ON FUNCTION public.whatsapp_cadencia_liberar_extra(uuid, text, integer, text, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_cadencia_liberar_extra(uuid, text, integer, text, date) TO authenticated;

-- checar: igual a 20260820150000, somando o extra do dia ao limite do operador.
CREATE OR REPLACE FUNCTION public.whatsapp_cadencia_checar(
  p_canal_id uuid, p_conversa_id uuid, p_operador text)
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
BEGIN
  SELECT * INTO v_canal FROM public.whatsapp_canais WHERE id = p_canal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'canal inexistente'; END IF;

  IF v_canal.modo = 'PAUSADO' THEN
    RAISE EXCEPTION 'o numero % esta pausado: nenhuma mensagem sai por ele', v_canal.apelido
      USING ERRCODE = '42501', DETAIL = 'MODO_PAUSADO';
  END IF;

  v_resposta := p_conversa_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.whatsapp_mensagens m
    WHERE m.conversa_id = p_conversa_id
      AND m.direcao = 'ENTRADA'
      AND m.timestamp_wa >= v_agora - interval '30 days'
  );

  IF v_resposta THEN
    RETURN 'RESPOSTA';
  END IF;

  IF v_canal.modo = 'SOMENTE_RESPOSTAS' THEN
    RAISE EXCEPTION 'o numero % so responde quem procurou a empresa nos ultimos 30 dias', v_canal.apelido
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
    RAISE EXCEPTION 'voce ja iniciou % conversas novas hoje neste numero. Responder quem te procurou continua liberado',
      v_limite_op
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
REVOKE ALL ON FUNCTION public.whatsapp_cadencia_checar(uuid, uuid, text) FROM public, anon, authenticated;

-- consumo: a tela bloqueia pelo contador; limite_operador ja sai com o extra do dia.
CREATE OR REPLACE FUNCTION public.whatsapp_cadencia_consumo()
RETURNS TABLE(canal_id uuid, canal_apelido text, modo text,
              limite_operador integer, usadas_operador integer,
              limite_canal integer, usadas_canal integer,
              janela_inicio time, janela_fim time, dentro_da_janela boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH agora AS (
    SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje,
           (now() AT TIME ZONE 'America/Sao_Paulo')::time AS hora
  )
  SELECT k.id, k.apelido, k.modo,
         CASE WHEN k.limite_abordagens_operador IS NULL THEN NULL
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
GRANT EXECUTE ON FUNCTION public.whatsapp_cadencia_consumo() TO authenticated;

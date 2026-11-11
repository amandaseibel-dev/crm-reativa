-- =====================================================================
-- ROLLBACK de 20261111150000_whatsapp_cota_10_operador
--
-- Volta ao estado "CONTINUIDADE v2 aplicada, cota antiga":
--   * whatsapp_cadencia_checar = corpo EXATO da v2 (20261109120000)
--   * whatsapp_cadencia_consumo e whatsapp_cadencia_indicadores = corpo
--     de produção lido em 11/11/2026
--   * whatsapp_abordagens sem origem/ciclo_desde/wamid e com o UNIQUE
--     (canal_id, conversa_id, dia) de volta
--   * teto_abordagens_operador 10 -> 3; limite por canal 10 -> fotografia
--     de 11/11 (Comercial 2, Cobrança 15, Piloto 3), SÓ onde ainda estiver
--     10 — valor mexido pela tela depois da aplicação não é sobrescrito
--
-- PERDA DE DADO, DECLARADA: as linhas origem = 'RECEPTIVA' são apagadas.
-- Sem isso o UNIQUE amplo não volta (troca de responsável no mesmo dia
-- gera duas linhas na mesma conversa/dia). São marcas derivadas: dá para
-- reconstruí-las de whatsapp_mensagens (primeiro ENVIADO do responsável
-- por ciclo). A contagem apagada sai em NOTICE.
--
-- GRANTS: checar volta ao estado de PRODUÇÃO (sem authenticated), e não ao
-- da v2, que concedia authenticated.
--
-- Idempotente: pode rodar duas vezes.
-- =====================================================================

-- 1. Marca RECEPTIVA desligada primeiro: nada novo entra durante o resto.
DROP TRIGGER IF EXISTS trg_whatsapp_cadencia_receptiva ON public.whatsapp_mensagens;
DROP FUNCTION IF EXISTS public.whatsapp_cadencia_marcar_receptiva();

-- 2. whatsapp_cadencia_checar: corpo exato da v2
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
BEGIN
  -- Lock da linha do canal: serializa toda a cadência deste canal.
  -- Fica ANTES de qualquer contagem, de CONTINUIDADE e do INSERT.
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

  -- RITMO: vale para abordagem E resposta, porque o WhatsApp olha o ritmo
  -- do numero, nao a nossa classificacao. Mesma conversa nao conta.
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

  -- RESPOSTA: aluno escreveu nas ultimas v_janela_h horas (24h, inalterado)
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

  -- ===================================================================
  -- CONTINUIDADE v2 — cinco condicoes, todas obrigatorias.
  -- Nenhuma delas e renovavel por acao do operador.
  -- ===================================================================
  IF v_cont_h > 0 AND v_cont_max > 0 AND p_conversa_id IS NOT NULL THEN

    -- cond. 5: conversa nao arquivada E nao encerrada (eixos independentes)
    SELECT (cv.arquivada_em IS NOT NULL OR cv.status = 'ENCERRADO')
      INTO v_conv_bloqueada
      FROM public.whatsapp_conversas cv
     WHERE cv.id = p_conversa_id;

    IF COALESCE(v_conv_bloqueada, true) = false THEN

      -- cond. 1: existe SAIDA anterior DESTE operador nesta conversa,
      -- qualquer classificacao (e o que a v1 nao enxergava)
      SELECT EXISTS (
        SELECT 1 FROM public.whatsapp_mensagens m
        WHERE m.conversa_id = p_conversa_id
          AND m.direcao = 'SAIDA'
          AND lower(m.enviado_por_email) = lower(p_operador)
      ) INTO v_tem_saida_dele;

      -- cond. 2 e 3: aluno ja respondeu, e a ultima resposta esta na janela.
      -- ANCORA NAO RENOVAVEL: timestamp_wa de ENTRADA. O operador nao
      -- consegue produzir uma ENTRADA, logo nenhum envio dele estende isto.
      SELECT max(m.timestamp_wa) INTO v_ult_entrada
        FROM public.whatsapp_mensagens m
       WHERE m.conversa_id = p_conversa_id
         AND m.direcao = 'ENTRADA';

      IF v_tem_saida_dele
         AND v_ult_entrada IS NOT NULL
         AND v_ult_entrada >= v_agora - make_interval(hours => v_cont_h)
      THEN
        -- cond. 4: teto de insistencia desde a ultima ENTRADA do aluno
        SELECT count(*) INTO v_sem_resposta
          FROM public.whatsapp_mensagens m
         WHERE m.conversa_id = p_conversa_id
           AND m.direcao = 'SAIDA'
           AND lower(m.enviado_por_email) = lower(p_operador)
           AND m.criado_em > v_ult_entrada;

        IF v_sem_resposta < v_cont_max THEN
          -- Retorna ANTES do INSERT: nao consome cota e nao cria registro,
          -- portanto nao realimenta nenhuma janela.
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

-- 3. whatsapp_cadencia_consumo: assinatura e corpo de produção (11/11/2026)
DROP FUNCTION IF EXISTS public.whatsapp_cadencia_consumo();

CREATE FUNCTION public.whatsapp_cadencia_consumo()
RETURNS TABLE(canal_id uuid, canal_apelido text, modo text, limite_operador integer,
              usadas_operador integer, limite_canal integer, usadas_canal integer,
              janela_inicio time without time zone, janela_fim time without time zone,
              dentro_da_janela boolean)
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

REVOKE ALL ON FUNCTION public.whatsapp_cadencia_consumo() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.whatsapp_cadencia_consumo() FROM anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_cadencia_consumo() TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_cadencia_consumo() TO service_role;

-- 4. whatsapp_cadencia_indicadores: corpo de produção (11/11/2026)
CREATE OR REPLACE FUNCTION public.whatsapp_cadencia_indicadores(p_dias integer DEFAULT 7)
RETURNS TABLE(dia date, canal_apelido text, abordagens integer, bloqueios integer, motivo_mais_comum text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH corte AS (
    SELECT ((now() AT TIME ZONE 'America/Sao_Paulo')::date
            - greatest(1, least(coalesce(p_dias, 7), 90))) AS de
  )
  SELECT a.dia, k.apelido,
         count(*)::integer,
         (SELECT count(*)::integer FROM public.whatsapp_cadencia_bloqueios b
           WHERE b.canal_id = a.canal_id
             AND (b.criado_em AT TIME ZONE 'America/Sao_Paulo')::date = a.dia),
         (SELECT b.motivo FROM public.whatsapp_cadencia_bloqueios b
           WHERE b.canal_id = a.canal_id
             AND (b.criado_em AT TIME ZONE 'America/Sao_Paulo')::date = a.dia
           GROUP BY b.motivo ORDER BY count(*) DESC LIMIT 1)
  FROM public.whatsapp_abordagens a
  JOIN public.whatsapp_canais k ON k.id = a.canal_id
  CROSS JOIN corte c
  WHERE public.usuario_e_gestao() AND a.dia >= c.de
  GROUP BY a.dia, a.canal_id, k.apelido
  ORDER BY a.dia DESC, k.apelido;
$function$;

REVOKE ALL ON FUNCTION public.whatsapp_cadencia_indicadores(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.whatsapp_cadencia_indicadores(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_cadencia_indicadores(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_cadencia_indicadores(integer) TO service_role;

-- 5. Helper de perfil: nada mais o referencia
DROP FUNCTION IF EXISTS public.whatsapp_cadencia_sem_limite_individual(text);

-- 6. Dados e estrutura de whatsapp_abordagens
DO $dados$
DECLARE v_n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'whatsapp_abordagens'
                AND column_name = 'origem') THEN
    EXECUTE 'DELETE FROM public.whatsapp_abordagens WHERE origem = ''RECEPTIVA''';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'rollback cota 10: % marcas RECEPTIVA apagadas', v_n;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'uq_whatsapp_abordagem'
                    AND conrelid = 'public.whatsapp_abordagens'::regclass) THEN
    ALTER TABLE public.whatsapp_abordagens
      ADD CONSTRAINT uq_whatsapp_abordagem UNIQUE (canal_id, conversa_id, dia);
  END IF;
END $dados$;

DROP INDEX IF EXISTS public.uq_whatsapp_abordagem_ativa;
DROP INDEX IF EXISTS public.uq_whatsapp_abordagem_receptiva_ciclo;
DROP INDEX IF EXISTS public.ix_whatsapp_abordagens_conversa_operador;

ALTER TABLE public.whatsapp_abordagens DROP CONSTRAINT IF EXISTS ck_whatsapp_abordagem_receptiva_ciclo;
ALTER TABLE public.whatsapp_abordagens DROP CONSTRAINT IF EXISTS ck_whatsapp_abordagem_origem;
ALTER TABLE public.whatsapp_abordagens DROP COLUMN IF EXISTS wamid;
ALTER TABLE public.whatsapp_abordagens DROP COLUMN IF EXISTS ciclo_desde;
ALTER TABLE public.whatsapp_abordagens DROP COLUMN IF EXISTS origem;

-- 7. Limites: fotografia de 11/11/2026, só onde a migration deixou 10
UPDATE public.whatsapp_config
   SET teto_abordagens_operador = 3
 WHERE teto_abordagens_operador = 10;

UPDATE public.whatsapp_canais k
   SET limite_abordagens_operador = f.antes
  FROM (VALUES ('b8f00c75-aee3-4d22-83b7-f0041be0ef71'::uuid, 2),   -- Comercial
               ('9f5fc202-3a22-4b24-8794-65fd92858e31'::uuid, 15),  -- Cobrança
               ('3628d3fd-ab44-4c47-bf42-3d344c1e9336'::uuid, 3))   -- Piloto
       AS f(id, antes)
 WHERE k.id = f.id AND k.limite_abordagens_operador = 10;

-- 8. Conferência: falha fechado
DO $verifica$
DECLARE v_src text; v_n integer;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'whatsapp_cadencia_checar';
  IF v_src NOT ILIKE '%CONTINUIDADE%' OR v_src ILIKE '%sem_limite_individual%' OR v_src ILIKE '%RECEPTIVA%' THEN
    RAISE EXCEPTION 'checar nao voltou ao corpo da v2' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgname = 'trg_whatsapp_cadencia_receptiva';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'trigger da marca RECEPTIVA continua de pe' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'whatsapp_abordagens'
     AND column_name IN ('origem', 'ciclo_desde', 'wamid');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'colunas novas de whatsapp_abordagens continuam de pe' USING ERRCODE = '22023';
  END IF;

  IF has_function_privilege('authenticated', 'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.whatsapp_cadencia_consumo()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.whatsapp_cadencia_consumo()', 'EXECUTE') THEN
    RAISE EXCEPTION 'grants fora do estado de producao' USING ERRCODE = '42501';
  END IF;

  RAISE NOTICE 'rollback cota 10 concluido: v2 de pe, cota antiga restaurada';
END $verifica$;

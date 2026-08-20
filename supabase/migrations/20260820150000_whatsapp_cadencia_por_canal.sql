-- Controle de cadencia por canal.
--
-- POR QUE NO BANCO E NAO NA TELA: o limite vale para TODOS os operadores ao
-- mesmo tempo. Teto de canal conferido no navegador seria conferido oito vezes,
-- cada uma com um numero diferente, e nenhuma valeria.
--
-- POR QUE NAS DUAS RPCs DE PREPARO: a Edge Function `whatsapp-send` faz
-- `if (erroPreparo) return 403` ANTES do `fetch` ao gateway. Levantar excecao
-- aqui e o que garante "nenhuma tentativa bloqueada chega ao gateway", sem
-- alterar a Edge e sem tocar no gateway. E nao ha terceiro caminho:
-- `whatsapp_preparar_envio` e `whatsapp_preparar_envio_novo` sao as unicas
-- funcoes que devolvem `sessao_chave`, e sem `sessao_chave` o gateway nao sabe
-- por qual numero enviar.

-- ============================== 1. configuracao ==============================
ALTER TABLE public.whatsapp_canais
  ADD COLUMN IF NOT EXISTS modo                       text,
  ADD COLUMN IF NOT EXISTS limite_abordagens_operador integer,
  ADD COLUMN IF NOT EXISTS limite_abordagens_canal    integer,
  ADD COLUMN IF NOT EXISTS janela_inicio              time,
  ADD COLUMN IF NOT EXISTS janela_fim                 time,
  ADD COLUMN IF NOT EXISTS modo_alterado_em           timestamptz,
  ADD COLUMN IF NOT EXISTS modo_alterado_por          text;

-- Canal novo nasce SEM poder abordar. E deliberado: um numero recem-pareado e
-- justamente o mais fragil, e o custo de errar para o lado permissivo e um
-- bloqueio do WhatsApp. Ligar o modo ativo passa a ser ato explicito da gestao.
ALTER TABLE public.whatsapp_canais ALTER COLUMN modo SET DEFAULT 'SOMENTE_RESPOSTAS';

UPDATE public.whatsapp_canais SET modo = 'SOMENTE_RESPOSTAS' WHERE modo IS NULL;
ALTER TABLE public.whatsapp_canais ALTER COLUMN modo SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE public.whatsapp_canais ADD CONSTRAINT ck_whatsapp_canal_modo
    CHECK (modo IN ('ATIVO_CONTROLADO','SOMENTE_RESPOSTAS','PAUSADO'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Os canais que JA existiam sao operacao em andamento, nao numero novo: entram
-- no regime definido para o canal 1.
UPDATE public.whatsapp_canais
SET modo                       = 'ATIVO_CONTROLADO',
    limite_abordagens_operador = 10,
    limite_abordagens_canal    = 100,
    janela_inicio              = '09:00',
    janela_fim                 = '20:00',
    modo_alterado_em           = now(),
    modo_alterado_por          = 'migration 20260820150000'
WHERE criado_em < now();

-- ============================== 2. contador =================================
-- POR QUE UMA TABELA E NAO UMA CONTAGEM SOBRE whatsapp_mensagens: a
-- classificacao "isto foi abordagem" depende do estado da conversa NO INSTANTE
-- do envio, e esse estado muda depois -- o aluno responde amanha e a mensagem
-- de hoje passaria a parecer resposta. Contar retroativamente daria numero
-- diferente a cada dia. Aqui grava-se na hora e nao se mexe mais.
CREATE TABLE IF NOT EXISTS public.whatsapp_abordagens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canal_id       uuid NOT NULL REFERENCES public.whatsapp_canais(id)    ON DELETE CASCADE,
  conversa_id    uuid NOT NULL REFERENCES public.whatsapp_conversas(id) ON DELETE CASCADE,
  operador_email text NOT NULL,
  dia            date NOT NULL,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  -- "10 novas abordagens" e 10 PESSOAS, nao 10 mensagens: insistir tres vezes
  -- no mesmo contato frio no mesmo dia consome 1 de cota, nao 3.
  CONSTRAINT uq_whatsapp_abordagem UNIQUE (canal_id, conversa_id, dia)
);

CREATE INDEX IF NOT EXISTS ix_whatsapp_abordagens_dia
  ON public.whatsapp_abordagens (canal_id, dia, operador_email);

-- Tentativas barradas. SEM CONTEUDO DA MENSAGEM E SEM TELEFONE -- so canal,
-- operador, referencia da conversa, quando e por que. O numero da pessoa nao
-- acrescenta nada ao indicador e seria PII guardada sem necessidade.
CREATE TABLE IF NOT EXISTS public.whatsapp_cadencia_bloqueios (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canal_id       uuid NOT NULL REFERENCES public.whatsapp_canais(id) ON DELETE CASCADE,
  -- Null quando a conversa nem chegou a existir: bloquear a criacao desfaz a
  -- conversa junto, e nao sobra id para referenciar.
  conversa_id    uuid,
  operador_email text NOT NULL,
  motivo         text NOT NULL,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_whatsapp_bloqueio_motivo CHECK (motivo IN (
    'MODO_PAUSADO','MODO_SOMENTE_RESPOSTAS','FORA_DA_JANELA',
    'LIMITE_OPERADOR','LIMITE_CANAL'))
);

CREATE INDEX IF NOT EXISTS ix_whatsapp_bloqueios_dia
  ON public.whatsapp_cadencia_bloqueios (canal_id, criado_em DESC);

-- Deny-all: nenhuma leitura direta. Tudo passa pelas RPCs SECURITY DEFINER,
-- que e o padrao do modulo e o que mantem o gate de gestao valendo.
ALTER TABLE public.whatsapp_abordagens          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_cadencia_bloqueios  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_abordagens         FROM public, anon, authenticated;
REVOKE ALL ON public.whatsapp_cadencia_bloqueios FROM public, anon, authenticated;

-- ============================== 3. a regra ==================================
CREATE OR REPLACE FUNCTION public.whatsapp_cadencia_checar(
  p_canal_id uuid, p_conversa_id uuid, p_operador text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_canal   public.whatsapp_canais%ROWTYPE;
  v_agora   timestamptz := now();
  -- America/Sao_Paulo, NUNCA UTC: `now()::date` viraria o dia as 21:00 de
  -- Brasilia -- a cota do operador reiniciaria no meio do expediente e a
  -- janela das 20:00 fecharia na hora errada.
  v_hoje    date := (v_agora AT TIME ZONE 'America/Sao_Paulo')::date;
  v_hora    time := (v_agora AT TIME ZONE 'America/Sao_Paulo')::time;
  v_resposta boolean;
  v_op      integer;
  v_ch      integer;
BEGIN
  -- FOR UPDATE serializa por canal. Sem isto, dois operadores enviando ao mesmo
  -- tempo contam 99 cada um, os dois passam, e o dia fecha em 101. Com 100
  -- envios por dia a disputa pelo lock e irrelevante.
  SELECT * INTO v_canal FROM public.whatsapp_canais WHERE id = p_canal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'canal inexistente'; END IF;

  IF v_canal.modo = 'PAUSADO' THEN
    RAISE EXCEPTION 'o numero % esta pausado: nenhuma mensagem sai por ele', v_canal.apelido
      USING ERRCODE = '42501', DETAIL = 'MODO_PAUSADO';
  END IF;

  -- RESPOSTA = o aluno escreveu nos ultimos 30 dias. Sem essa janela, quem
  -- mandou uma mensagem ha oito meses deixaria a conversa liberada para sempre,
  -- e abordagem fria passaria vestida de resposta, sem consumir cota.
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

  -- Os dois limites valem ao mesmo tempo. Mensagens distintas porque a acao do
  -- operador e diferente: num caso ele espera amanha, no outro ele nem e o
  -- responsavel pelo teto.
  IF v_canal.limite_abordagens_operador IS NOT NULL
     AND v_op > v_canal.limite_abordagens_operador THEN
    RAISE EXCEPTION 'voce ja iniciou % conversas novas hoje neste numero. Responder quem te procurou continua liberado',
      v_canal.limite_abordagens_operador
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

-- ============================== 4. os dois portoes ==========================
CREATE OR REPLACE FUNCTION public.whatsapp_preparar_envio(p_conversa_id uuid)
RETURNS TABLE(sessao_chave text, telefone_e164 text, operador_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_conv  public.whatsapp_conversas%ROWTYPE;
  v_canal public.whatsapp_canais%ROWTYPE;
  v_email text := public.app_email();
  v_nome  text;
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_conv FROM public.whatsapp_conversas WHERE id = p_conversa_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversa inexistente'; END IF;

  SELECT * INTO v_canal FROM public.whatsapp_canais WHERE id = v_conv.canal_id;
  IF NOT FOUND OR NOT v_canal.ativo THEN RAISE EXCEPTION 'canal inativo'; END IF;

  IF v_canal.conexao_status <> 'CONECTADO' THEN
    RAISE EXCEPTION 'numero % esta % - reconecte antes de responder',
      v_canal.apelido, v_canal.conexao_status USING ERRCODE = '42501';
  END IF;

  IF v_conv.responsavel_email IS NOT NULL
     AND v_conv.responsavel_email <> v_email
     AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'conversa em atendimento por %', v_conv.responsavel_email
      USING ERRCODE = '42501';
  END IF;

  -- CADENCIA. Vem DEPOIS das travas de acesso e ANTES de assumir a conversa:
  -- envio barrado nao pode deixar o operador marcado como responsavel de uma
  -- conversa que ele nao conseguiu atender.
  PERFORM public.whatsapp_cadencia_checar(v_conv.canal_id, p_conversa_id, v_email);

  IF v_conv.responsavel_email IS NULL THEN
    SELECT u.nome INTO v_nome FROM public.usuarios u WHERE u.email = v_email;
    UPDATE public.whatsapp_conversas
    SET responsavel_email = v_email,
        responsavel_nome  = coalesce(v_nome, v_email),
        responsavel_desde = now(),
        status            = 'EM_ATENDIMENTO',
        atualizado_em     = now()
    WHERE id = p_conversa_id;
  END IF;

  RETURN QUERY SELECT v_canal.sessao_chave, v_conv.telefone_e164, v_email;
END;
$function$;

CREATE OR REPLACE FUNCTION public.whatsapp_preparar_envio_novo(
  p_canal_id uuid, p_telefone text, p_aluno_id uuid DEFAULT NULL)
RETURNS TABLE(conversa_id uuid, sessao_chave text, telefone_e164 text,
              operador_email text, ja_existia boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_canal public.whatsapp_canais%ROWTYPE;
  v_conv  public.whatsapp_conversas%ROWTYPE;
  v_email text := public.app_email();
  v_nome  text;
  v_e164  text := public.whatsapp_normalizar_telefone(p_telefone);
  v_ident record;
  v_id    uuid;
  v_novo  boolean := false;
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  IF v_e164 IS NULL THEN
    RAISE EXCEPTION 'telefone invalido: informe DDD e numero' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_canal FROM public.whatsapp_canais WHERE id = p_canal_id;
  IF NOT FOUND OR NOT v_canal.ativo THEN
    RAISE EXCEPTION 'canal inativo' USING ERRCODE = '42501';
  END IF;

  IF v_canal.conexao_status <> 'CONECTADO' THEN
    RAISE EXCEPTION 'numero % esta % - reconecte antes de iniciar conversa',
      v_canal.apelido, v_canal.conexao_status USING ERRCODE = '42501';
  END IF;

  SELECT u.nome INTO v_nome FROM public.usuarios u WHERE u.email = v_email;

  SELECT c.* INTO v_conv
  FROM public.whatsapp_conversas c
  WHERE c.canal_id = p_canal_id AND c.telefone_e164 = v_e164
  FOR UPDATE;

  IF FOUND THEN
    IF v_conv.responsavel_email IS NOT NULL
       AND v_conv.responsavel_email <> v_email
       AND NOT public.usuario_e_gestao() THEN
      RAISE EXCEPTION 'ja existe conversa com este numero, em atendimento por %',
        coalesce(v_conv.responsavel_nome, v_conv.responsavel_email) USING ERRCODE = '42501';
    END IF;

    v_id := v_conv.id;

    -- CADENCIA antes de assumir: a conversa ja existe, mas se o aluno nao
    -- escreveu nos ultimos 30 dias isto e abordagem, nao resposta.
    PERFORM public.whatsapp_cadencia_checar(p_canal_id, v_id, v_email);

    UPDATE public.whatsapp_conversas c
    SET responsavel_email = coalesce(c.responsavel_email, v_email),
        responsavel_nome  = coalesce(c.responsavel_nome, v_nome, v_email),
        responsavel_desde = coalesce(c.responsavel_desde, now()),
        status            = CASE WHEN c.status = 'ENCERRADO' THEN 'EM_ATENDIMENTO' ELSE c.status END,
        aluno_id          = coalesce(p_aluno_id, c.aluno_id),
        atualizado_em     = now()
    WHERE c.id = v_id;

  ELSE
    v_novo := true;

    SELECT * INTO v_ident FROM public.whatsapp_identificar_aluno(v_e164);

    INSERT INTO public.whatsapp_conversas (
      canal_id, telefone_e164, nome_perfil, status,
      aluno_id, aluno_nome, aluno_status, aluno_candidatos, aluno_identificado_em,
      origem_sync, responsavel_email, responsavel_nome, responsavel_desde
    ) VALUES (
      p_canal_id, v_e164, NULL, 'EM_ATENDIMENTO',
      coalesce(p_aluno_id, v_ident.aluno_id), v_ident.aluno_nome, v_ident.situacao,
      v_ident.candidatos, now(), false,
      v_email, coalesce(v_nome, v_email), now()
    )
    RETURNING id INTO v_id;

    -- A conversa nasce e SO ENTAO passa pela cadencia. Se barrar, a excecao
    -- desfaz o INSERT junto: nao sobra conversa vazia na caixa de entrada, que
    -- e a mesma razao de a conversa nascer dentro do envio e nao ao abrir o
    -- formulario.
    PERFORM public.whatsapp_cadencia_checar(p_canal_id, v_id, v_email);
  END IF;

  RETURN QUERY SELECT v_id, v_canal.sessao_chave, v_e164, v_email, NOT v_novo;
END;
$function$;

-- ============================== 5. leitura para a tela ======================
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
         k.limite_abordagens_operador,
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

-- ============================== 6. registro do bloqueio =====================
-- Chamada pela Edge Function DEPOIS de receber o 403. Precisa ser transacao
-- separada: a excecao que barra o envio desfaz tudo o que a propria transacao
-- teria gravado, inclusive um log.
CREATE OR REPLACE FUNCTION public.whatsapp_cadencia_registrar_bloqueio(
  p_canal_id uuid, p_conversa_id uuid, p_motivo text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.whatsapp_cadencia_bloqueios (canal_id, conversa_id, operador_email, motivo)
  VALUES (p_canal_id, p_conversa_id, public.app_email(), p_motivo);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.whatsapp_cadencia_registrar_bloqueio(uuid, uuid, text) TO authenticated;

-- ============================== 7. configurar (gestao) ======================
CREATE OR REPLACE FUNCTION public.whatsapp_canal_cadencia_salvar(
  p_canal_id uuid, p_modo text,
  p_limite_operador integer DEFAULT NULL, p_limite_canal integer DEFAULT NULL,
  p_janela_inicio time DEFAULT NULL, p_janela_fim time DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'somente gestao' USING ERRCODE = '42501';
  END IF;

  IF p_modo NOT IN ('ATIVO_CONTROLADO','SOMENTE_RESPOSTAS','PAUSADO') THEN
    RAISE EXCEPTION 'modo invalido: %', p_modo;
  END IF;

  IF coalesce(p_limite_operador, 0) < 0 OR coalesce(p_limite_canal, 0) < 0 THEN
    RAISE EXCEPTION 'limite nao pode ser negativo';
  END IF;

  IF p_janela_inicio IS NOT NULL AND p_janela_fim IS NOT NULL
     AND p_janela_inicio >= p_janela_fim THEN
    RAISE EXCEPTION 'janela invalida: inicio precisa ser antes do fim';
  END IF;

  UPDATE public.whatsapp_canais
  SET modo                       = p_modo,
      limite_abordagens_operador = p_limite_operador,
      limite_abordagens_canal    = p_limite_canal,
      janela_inicio              = p_janela_inicio,
      janela_fim                 = p_janela_fim,
      modo_alterado_em           = now(),
      modo_alterado_por          = public.app_email()
  WHERE id = p_canal_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.whatsapp_canal_cadencia_salvar(uuid, text, integer, integer, time, time) TO authenticated;

-- ============================== 8. indicadores (gestao) =====================
CREATE OR REPLACE FUNCTION public.whatsapp_cadencia_indicadores(p_dias integer DEFAULT 7)
RETURNS TABLE(dia date, canal_apelido text, abordagens integer,
              bloqueios integer, motivo_mais_comum text)
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

GRANT EXECUTE ON FUNCTION public.whatsapp_cadencia_indicadores(integer) TO authenticated;

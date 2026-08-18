-- Central WhatsApp — alerta de INDISPONIBILIDADE da sessão
-- =============================================================================
-- O vigia anterior (20260818130000) só enxergava o SERVIÇO morrer: sem
-- heartbeat, avisa. Mas existe um caso pior e mais comum — o serviço vivo,
-- batendo o coração normalmente, com a SESSÃO do WhatsApp fora do ar. Nesse
-- cenário o alerta antigo ficava calado justamente quando alguém precisava agir.
--
-- Agora são TRÊS motivos, com mensagens diferentes, porque a ação da gestão é
-- diferente em cada um:
--
--   SEM_HEARTBEAT          -> o serviço na VPS parou. Mexer no servidor.
--   PAREAMENTO_NECESSARIO  -> serviço no ar, sessão caiu. Ler o QR na Central.
--   ERRO                   -> serviço no ar, sessão em erro. Ler o detalhe.
--
-- POR QUE `AGUARDANDO_QR` ENTRA JUNTO COM `PAREAMENTO_NECESSARIO`:
-- no gateway, quando a sessão é encerrada no celular, o estado
-- `PAREAMENTO_NECESSARIO` dura cerca de CINCO SEGUNDOS — logo em seguida o
-- serviço já pede um QR novo e o estado passa a `AGUARDANDO_QR`, onde fica
-- parado (reafirmado a cada batimento de 30s) até alguém escanear. Um cron de 5
-- em 5 minutos praticamente nunca veria `PAREAMENTO_NECESSARIO`. Alertar apenas
-- nele seria um alarme que nunca toca. Os dois estados significam a mesma coisa
-- para quem opera: **este número precisa de QR novo**.
--
-- QUAL MOTIVO GANHA quando mais de um se aplica: SEM_HEARTBEAT sempre. Se o
-- serviço parou, o `conexao_status` gravado é informação velha — foi o próprio
-- serviço morto que escreveu, antes de morrer. Não dá para confiar nele.
--
-- O QUE CONTA COMO "VOLTOU": heartbeat em dia **e** `CONECTADO`. Nada menos.
-- `AGUARDANDO_QR` não é recuperação — é exatamente o estado que gerou o alerta.
-- `CONECTANDO` também não: ainda está tentando.
--
-- FALSO ALERTA NO SETUP: nenhum alerta é gerado para canal que nunca conectou
-- (`conectado_em IS NULL`). Cadastrar o número e ficar em `DESCONECTADO` ou
-- `AGUARDANDO_QR` antes do primeiro pareamento é o fluxo normal de implantação,
-- não é queda. `DESCONECTADO` sozinho nunca alerta: com o serviço vivo é estado
-- transitório de reconexão, e com o serviço morto quem acusa é o heartbeat.
--
-- Migration INCREMENTAL: a 20260818130000 já foi aplicada em staging.
-- Idempotente. NÃO aplicada em produção.
-- =============================================================================

------------------------------------------------------------------------------
-- 1) Guarda qual foi o motivo do alerta em vigor. Serve para escrever a
--    mensagem certa, para dizer do que a sessão se recuperou e para registrar
--    no diário quando o motivo muda no meio da queda.
------------------------------------------------------------------------------
ALTER TABLE public.whatsapp_canais ADD COLUMN IF NOT EXISTS alerta_motivo text;

COMMENT ON COLUMN public.whatsapp_canais.alerta_motivo IS
  'Motivo do alerta em vigor: SEM_HEARTBEAT | PAREAMENTO_NECESSARIO | ERRO. NULO = operacional.';

------------------------------------------------------------------------------
-- 2) A regra, em UM lugar só.
--
--    Devolve NULO quando o canal está operacional. Ter isto como função evita a
--    armadilha de repetir a mesma condição em três consultas e uma delas ficar
--    para trás numa alteração futura.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_motivo_indisponibilidade(
  p_ultimo_heartbeat timestamptz,
  p_status           text,
  p_limite_min       integer
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    -- Serviço morto vem primeiro: o status gravado não é confiável.
    WHEN p_ultimo_heartbeat IS NULL
      OR p_ultimo_heartbeat < now() - make_interval(mins => greatest(coalesce(p_limite_min,5),1))
      THEN 'SEM_HEARTBEAT'
    -- Serviço vivo, sessão pedindo QR. AGUARDANDO_QR é onde o gateway fica
    -- parado de verdade; PAREAMENTO_NECESSARIO passa em segundos.
    WHEN p_status IN ('PAREAMENTO_NECESSARIO', 'AGUARDANDO_QR')
      THEN 'PAREAMENTO_NECESSARIO'
    WHEN p_status = 'ERRO'
      THEN 'ERRO'
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_motivo_indisponibilidade(timestamptz,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_motivo_indisponibilidade(timestamptz,text,integer) TO authenticated;

------------------------------------------------------------------------------
-- 3) Texto de cada motivo. Fora da função principal para a mensagem poder ser
--    conferida isoladamente — e para ninguém precisar ler plpgsql para saber o
--    que a gestão vai receber às 3 da manhã.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_texto_alerta(
  p_motivo   text,
  p_apelido  text,
  p_numero   text,
  p_tempo    text,
  p_detalhe  text
)
RETURNS TABLE (titulo text, mensagem text)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    CASE p_motivo
      WHEN 'SEM_HEARTBEAT'         THEN '🔴 WhatsApp ' || p_apelido || ': servidor sem sinal'
      WHEN 'PAREAMENTO_NECESSARIO' THEN '🟠 WhatsApp ' || p_apelido || ': precisa de QR Code novo'
      WHEN 'ERRO'                  THEN '🔴 WhatsApp ' || p_apelido || ': sessão com erro'
      ELSE '🔴 WhatsApp ' || p_apelido || ' indisponível'
    END,
    CASE p_motivo
      WHEN 'SEM_HEARTBEAT' THEN
        'O serviço que mantém a conexão do número ' || p_numero || ' (' || p_apelido
        || ') parou de dar sinal há ' || p_tempo
        || '. Não é a sessão do WhatsApp: é o servidor. Enquanto isso, mensagem nova não entra na Central.'
      WHEN 'PAREAMENTO_NECESSARIO' THEN
        'O servidor está no ar, mas a sessão do número ' || p_numero || ' (' || p_apelido
        || ') caiu e precisa ser pareada de novo — está assim há ' || p_tempo
        || '. A gestão precisa ler o QR Code na Central. Mensagem que chegar nesse período não entra no CRM.'
      WHEN 'ERRO' THEN
        'O servidor está no ar, mas a sessão do número ' || p_numero || ' (' || p_apelido
        || ') está em erro há ' || p_tempo
        || coalesce('. Detalhe: ' || nullif(btrim(p_detalhe), ''), '')
        || '. Mensagem nova não entra na Central enquanto não voltar.'
      ELSE
        'O número ' || p_numero || ' (' || p_apelido || ') está indisponível há ' || p_tempo || '.'
    END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_texto_alerta(text,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_texto_alerta(text,text,text,text,text) TO authenticated;

------------------------------------------------------------------------------
-- 4) O vigia, agora com os três motivos.
--
--    A assinatura de retorno mudou (ganhou `motivo`), então precisa de DROP
--    antes: CREATE OR REPLACE não troca o tipo de retorno de uma função.
------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.whatsapp_monitorar_sessoes();

CREATE FUNCTION public.whatsapp_monitorar_sessoes()
RETURNS TABLE (
  id_canal        uuid,
  nome_canal      text,
  acao            text,        -- ALERTA | RECUPERACAO | MOTIVO_MUDOU
  motivo          text,        -- SEM_HEARTBEAT | PAREAMENTO_NECESSARIO | ERRO
  sem_sinal_desde timestamptz,
  tempo           text,
  notificados     integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Mesma lista de `usuario_e_gestao()`, no formato que o projeto já usa para
  -- avisar a gestão. Se a lista mudar lá, muda aqui.
  v_admins text[] := array[
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  ];
  v_limite integer;
  r        record;
  t        record;
  v_qtd    integer;
BEGIN
  SELECT minutos_sem_heartbeat_alerta INTO v_limite FROM public.whatsapp_config WHERE id;
  v_limite := greatest(coalesce(v_limite, 5), 1);

  ---------------------------------------------------------------------------
  -- ALERTA. Marcar e reservar acontecem no MESMO comando: quem não conseguir
  -- marcar não avisa, então duas execuções simultâneas do cron não conseguem
  -- notificar duas vezes.
  ---------------------------------------------------------------------------
  FOR r IN
    WITH indisponiveis AS (
      UPDATE public.whatsapp_canais k
      SET alerta_fora_desde = coalesce(k.alerta_fora_desde, k.ultimo_heartbeat_em, now()),
          alerta_ultimo_em  = now(),
          alerta_motivo     = public.whatsapp_motivo_indisponibilidade(
                                k.ultimo_heartbeat_em, k.conexao_status, v_limite)
      WHERE k.ativo
        -- nunca esteve no ar => não caiu, ainda não subiu (regra do setup)
        AND k.conectado_em IS NOT NULL
        AND public.whatsapp_motivo_indisponibilidade(
              k.ultimo_heartbeat_em, k.conexao_status, v_limite) IS NOT NULL
        -- trava de 1 aviso por hora enquanto continuar fora
        AND (k.alerta_ultimo_em IS NULL
             OR k.alerta_ultimo_em < now() - interval '1 hour')
      RETURNING k.id, k.apelido, k.display_phone_number, k.conexao_status,
                k.conexao_detalhe, k.alerta_fora_desde, k.alerta_motivo
    )
    SELECT * FROM indisponiveis
  LOOP
    SELECT * INTO t FROM public.whatsapp_texto_alerta(
      r.alerta_motivo, r.apelido, r.display_phone_number,
      public.whatsapp_tempo_humano(r.alerta_fora_desde), r.conexao_detalhe);

    INSERT INTO public.notificacoes (
      usuario_destino_email, usuario_destino_nome, tipo, titulo, mensagem,
      url_destino, lida, criado_em
    )
    SELECT lower(e), NULL, 'WHATSAPP_SESSAO_FORA', t.titulo, t.mensagem,
           '/central-whatsapp', false, now()
    FROM unnest(v_admins) AS e;

    GET DIAGNOSTICS v_qtd = ROW_COUNT;

    INSERT INTO public.whatsapp_conexao_eventos (canal_id, evento, detalhe)
    VALUES (r.id, 'ALERTA_FORA',
            r.alerta_motivo || ' desde ' || to_char(r.alerta_fora_desde, 'DD/MM HH24:MI'));

    id_canal := r.id;      nome_canal := r.apelido;
    acao := 'ALERTA';      motivo := r.alerta_motivo;
    sem_sinal_desde := r.alerta_fora_desde;
    tempo := public.whatsapp_tempo_humano(r.alerta_fora_desde);
    notificados := v_qtd;
    RETURN NEXT;
  END LOOP;

  ---------------------------------------------------------------------------
  -- MOTIVO MUDOU no meio da queda (ex.: pedia QR e depois o servidor morreu).
  -- NÃO gera notificação nova — a trava de 1 hora vale. Mas atualiza o motivo,
  -- para o próximo aviso da hora dizer a verdade, e deixa rastro no diário.
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT k.id, k.apelido, k.alerta_motivo AS motivo_antigo, k.alerta_fora_desde,
           public.whatsapp_motivo_indisponibilidade(
             k.ultimo_heartbeat_em, k.conexao_status, v_limite) AS motivo_novo
    FROM public.whatsapp_canais k
    WHERE k.alerta_fora_desde IS NOT NULL
      AND public.whatsapp_motivo_indisponibilidade(
            k.ultimo_heartbeat_em, k.conexao_status, v_limite) IS NOT NULL
      AND k.alerta_motivo IS DISTINCT FROM public.whatsapp_motivo_indisponibilidade(
            k.ultimo_heartbeat_em, k.conexao_status, v_limite)
    FOR UPDATE
  LOOP
    UPDATE public.whatsapp_canais SET alerta_motivo = r.motivo_novo WHERE id = r.id;

    INSERT INTO public.whatsapp_conexao_eventos (canal_id, evento, detalhe)
    VALUES (r.id, 'ALERTA_MOTIVO_MUDOU',
            coalesce(r.motivo_antigo, 'NULO') || ' -> ' || r.motivo_novo);

    id_canal := r.id;      nome_canal := r.apelido;
    acao := 'MOTIVO_MUDOU'; motivo := r.motivo_novo;
    sem_sinal_desde := r.alerta_fora_desde;
    tempo := public.whatsapp_tempo_humano(r.alerta_fora_desde);
    notificados := 0;
    RETURN NEXT;
  END LOOP;

  ---------------------------------------------------------------------------
  -- RECUPERAÇÃO. Uma só, quando volta ao estado operacional de verdade:
  -- heartbeat em dia E `CONECTADO`.
  --
  -- Precisa ler o valor ANTIGO de `alerta_fora_desde` para dizer quanto tempo
  -- ficou fora, então seleciona (travando a linha) antes de limpar.
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT k.id, k.apelido, k.display_phone_number, k.alerta_fora_desde, k.alerta_motivo
    FROM public.whatsapp_canais k
    WHERE k.alerta_fora_desde IS NOT NULL
      AND k.conexao_status = 'CONECTADO'
      AND public.whatsapp_motivo_indisponibilidade(
            k.ultimo_heartbeat_em, k.conexao_status, v_limite) IS NULL
    FOR UPDATE
  LOOP
    UPDATE public.whatsapp_canais
    SET alerta_fora_desde = NULL, alerta_ultimo_em = NULL, alerta_motivo = NULL
    WHERE id = r.id;

    INSERT INTO public.notificacoes (
      usuario_destino_email, usuario_destino_nome, tipo, titulo, mensagem,
      url_destino, lida, criado_em
    )
    SELECT
      lower(e), NULL, 'WHATSAPP_SESSAO_VOLTOU',
      '🟢 WhatsApp ' || r.apelido || ' voltou',
      'O número ' || r.display_phone_number || ' (' || r.apelido || ') voltou a operar após '
        || public.whatsapp_tempo_humano(r.alerta_fora_desde) || ' fora'
        || coalesce(' (' || r.alerta_motivo || ')', '')
        || '. Vale conferir se ficou mensagem sem resposta no período.',
      '/central-whatsapp', false, now()
    FROM unnest(v_admins) AS e;

    GET DIAGNOSTICS v_qtd = ROW_COUNT;

    INSERT INTO public.whatsapp_conexao_eventos (canal_id, evento, detalhe)
    VALUES (r.id, 'RECUPERADO',
            'voltou apos ' || public.whatsapp_tempo_humano(r.alerta_fora_desde)
            || ' fora' || coalesce(' (' || r.alerta_motivo || ')', ''));

    id_canal := r.id;         nome_canal := r.apelido;
    acao := 'RECUPERACAO';    motivo := r.alerta_motivo;
    sem_sinal_desde := r.alerta_fora_desde;
    tempo := public.whatsapp_tempo_humano(r.alerta_fora_desde);
    notificados := v_qtd;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_monitorar_sessoes() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.whatsapp_monitorar_sessoes() IS
  'Vigia das sessoes do WhatsApp: avisa a gestao por tres motivos distintos (servidor sem heartbeat, sessao pedindo QR, sessao em erro), 1 aviso por hora, e uma unica notificacao de recuperacao quando volta a CONECTADO. Roda a cada 5 min via cron.';

------------------------------------------------------------------------------
-- 5) O agendamento continua o mesmo (a cada 5 min). Reagenda para garantir que
--    o cron aponte para a função nova depois do DROP.
------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('whatsapp_monitor_sessoes')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'whatsapp_monitor_sessoes');

    PERFORM cron.schedule(
      'whatsapp_monitor_sessoes',
      '*/5 * * * *',
      $cron$ SELECT public.whatsapp_monitorar_sessoes(); $cron$
    );
  END IF;
END $$;

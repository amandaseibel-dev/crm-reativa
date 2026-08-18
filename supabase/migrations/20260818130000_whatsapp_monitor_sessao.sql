-- Central WhatsApp — vigia automático das sessões (bloqueador A1)
-- =============================================================================
-- PROBLEMA QUE ISTO RESOLVE: até aqui, uma sessão caída só era percebida por
-- alguém olhando a Central e vendo o número vermelho. Fora do horário
-- comercial, um número podia ficar fora a noite inteira sem ninguém saber — e o
-- módulo inteiro existe para NÃO perder contato de aluno.
--
-- REGRA (a que foi pedida): o gateway bate o coração a cada 30s gravando
-- `whatsapp_canais.ultimo_heartbeat_em`. Se esse sinal parar por mais de
-- `whatsapp_config.minutos_sem_heartbeat_alerta` minutos, a gestão é avisada.
-- Processo morto nunca reporta que morreu — por isso o critério é a AUSÊNCIA de
-- sinal, e não o último status que o próprio serviço gravou.
--
-- TRÊS CUIDADOS QUE MUDAM O COMPORTAMENTO:
--
--   1. Canal que NUNCA conectou (`conectado_em IS NULL`) não gera alerta. Ele
--      não caiu: ainda não subiu. Sem isso, cadastrar um número antes de parear
--      encheria o sino de aviso de uma queda que não existiu.
--
--   2. Uma notificação por hora por canal, enquanto continuar fora. O padrão é
--      o mesmo já usado no projeto para canal fora do ar. A trava é uma coluna,
--      não uma contagem em `notificacoes` — assim continua funcionando mesmo
--      que alguém apague as notificações.
--
--   3. A marcação do alerta e o envio acontecem no MESMO comando
--      (`UPDATE ... RETURNING`), então duas execuções simultâneas do cron não
--      conseguem avisar duas vezes.
--
-- LIMITE CONHECIDO, DE PROPÓSITO: este vigia detecta o SERVIÇO fora do ar. Se o
-- serviço estiver de pé mas a sessão precisar de QR novo
-- (`PAREAMENTO_NECESSARIO`), o batimento continua chegando e este alerta NÃO
-- dispara. Cobrir esse caso é uma linha a mais na condição, mas muda a regra que
-- foi especificada — fica para decisão.
--
-- Migration INCREMENTAL: a 20260817120000 já foi aplicada em staging, então
-- nada é editado nela. Idempotente. NÃO aplicada em produção.
-- =============================================================================

------------------------------------------------------------------------------
-- 1) Estado do alerta, no próprio canal.
--
--    `alerta_fora_desde` guarda desde quando está sem sinal (serve para dizer
--    "há quanto tempo" e para medir a duração da queda quando voltar).
--    `alerta_ultimo_em` é a trava de uma notificação por hora.
------------------------------------------------------------------------------
ALTER TABLE public.whatsapp_canais ADD COLUMN IF NOT EXISTS alerta_fora_desde timestamptz;
ALTER TABLE public.whatsapp_canais ADD COLUMN IF NOT EXISTS alerta_ultimo_em  timestamptz;

COMMENT ON COLUMN public.whatsapp_canais.alerta_fora_desde IS
  'Desde quando o canal esta sem heartbeat. NULO = esta no ar (ou nunca alertou).';
COMMENT ON COLUMN public.whatsapp_canais.alerta_ultimo_em IS
  'Ultimo aviso enviado a gestao. Trava de 1 por hora enquanto continuar fora.';

------------------------------------------------------------------------------
-- 2) Tempo em português, curto. A notificação precisa dizer "há 12 min", não
--    despejar um timestamp para a gestão interpretar de madrugada.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_tempo_humano(p_desde timestamptz)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN p_desde IS NULL THEN 'tempo indeterminado'
    WHEN now() - p_desde < interval '1 minute'  THEN 'menos de 1 min'
    WHEN now() - p_desde < interval '1 hour'
      THEN floor(extract(epoch FROM (now() - p_desde)) / 60)::int || ' min'
    WHEN now() - p_desde < interval '1 day'
      THEN floor(extract(epoch FROM (now() - p_desde)) / 3600)::int || 'h'
    ELSE floor(extract(epoch FROM (now() - p_desde)) / 86400)::int || 'd'
  END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_tempo_humano(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_tempo_humano(timestamptz) TO authenticated;

------------------------------------------------------------------------------
-- 3) O vigia. Roda a cada 5 minutos pelo cron.
--
--    Devolve o que fez, em vez de rodar em silêncio: é o que permite testar o
--    fluxo e conferir depois de um incidente.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_monitorar_sessoes()
RETURNS TABLE (
  id_canal        uuid,
  nome_canal      text,
  acao            text,        -- ALERTA | RECUPERACAO
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
  v_qtd    integer;
BEGIN
  SELECT minutos_sem_heartbeat_alerta INTO v_limite FROM public.whatsapp_config WHERE id;
  v_limite := greatest(coalesce(v_limite, 5), 1);

  ---------------------------------------------------------------------------
  -- QUEDA. O UPDATE marca e reserva o alerta no mesmo comando: quem não
  -- conseguir marcar, não avisa. Isso torna a duplicata impossível.
  ---------------------------------------------------------------------------
  FOR r IN
    WITH caidos AS (
      UPDATE public.whatsapp_canais k
      SET alerta_fora_desde = coalesce(k.alerta_fora_desde, k.ultimo_heartbeat_em, now()),
          alerta_ultimo_em  = now()
      WHERE k.ativo
        -- nunca esteve no ar => não caiu, ainda não subiu
        AND k.conectado_em IS NOT NULL
        AND (k.ultimo_heartbeat_em IS NULL
             OR k.ultimo_heartbeat_em < now() - make_interval(mins => v_limite))
        -- trava de 1 aviso por hora enquanto continuar fora
        AND (k.alerta_ultimo_em IS NULL
             OR k.alerta_ultimo_em < now() - interval '1 hour')
      RETURNING k.id, k.apelido, k.display_phone_number, k.conexao_status, k.alerta_fora_desde
    )
    SELECT * FROM caidos
  LOOP
    INSERT INTO public.notificacoes (
      usuario_destino_email, usuario_destino_nome, tipo, titulo, mensagem,
      url_destino, lida, criado_em
    )
    SELECT
      lower(e), NULL, 'WHATSAPP_SESSAO_FORA',
      '🔴 WhatsApp ' || r.apelido || ' fora do ar',
      'O número ' || r.display_phone_number || ' (' || r.apelido || ') está sem sinal há '
        || public.whatsapp_tempo_humano(r.alerta_fora_desde)
        || '. Último estado reportado: ' || r.conexao_status
        || '. Enquanto estiver fora, mensagem nova não entra na Central.',
      '/central-whatsapp', false, now()
    FROM unnest(v_admins) AS e;

    GET DIAGNOSTICS v_qtd = ROW_COUNT;

    INSERT INTO public.whatsapp_conexao_eventos (canal_id, evento, detalhe)
    VALUES (r.id, 'ALERTA_FORA',
            'sem heartbeat desde ' || to_char(r.alerta_fora_desde, 'DD/MM HH24:MI'));

    id_canal := r.id;
    nome_canal := r.apelido;
    acao := 'ALERTA';
    sem_sinal_desde := r.alerta_fora_desde;
    tempo := public.whatsapp_tempo_humano(r.alerta_fora_desde);
    notificados := v_qtd;
    RETURN NEXT;
  END LOOP;

  ---------------------------------------------------------------------------
  -- RECUPERAÇÃO. Precisa ler o valor ANTIGO de `alerta_fora_desde` para dizer
  -- quanto tempo ficou fora, então seleciona (travando a linha) antes de
  -- limpar. O FOR UPDATE impede duas execuções relatarem a mesma volta.
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT k.id, k.apelido, k.display_phone_number, k.alerta_fora_desde, k.conexao_status
    FROM public.whatsapp_canais k
    WHERE k.alerta_fora_desde IS NOT NULL
      AND k.ultimo_heartbeat_em IS NOT NULL
      AND k.ultimo_heartbeat_em >= now() - make_interval(mins => v_limite)
    FOR UPDATE
  LOOP
    UPDATE public.whatsapp_canais
    SET alerta_fora_desde = NULL, alerta_ultimo_em = NULL
    WHERE id = r.id;

    INSERT INTO public.notificacoes (
      usuario_destino_email, usuario_destino_nome, tipo, titulo, mensagem,
      url_destino, lida, criado_em
    )
    SELECT
      lower(e), NULL, 'WHATSAPP_SESSAO_VOLTOU',
      '🟢 WhatsApp ' || r.apelido || ' voltou',
      'O número ' || r.display_phone_number || ' (' || r.apelido || ') voltou a dar sinal após '
        || public.whatsapp_tempo_humano(r.alerta_fora_desde)
        || ' fora. Vale conferir se ficou mensagem sem resposta no período.',
      '/central-whatsapp', false, now()
    FROM unnest(v_admins) AS e;

    GET DIAGNOSTICS v_qtd = ROW_COUNT;

    INSERT INTO public.whatsapp_conexao_eventos (canal_id, evento, detalhe)
    VALUES (r.id, 'RECUPERADO',
            'voltou apos ' || public.whatsapp_tempo_humano(r.alerta_fora_desde) || ' fora');

    id_canal := r.id;
    nome_canal := r.apelido;
    acao := 'RECUPERACAO';
    sem_sinal_desde := r.alerta_fora_desde;
    tempo := public.whatsapp_tempo_humano(r.alerta_fora_desde);
    notificados := v_qtd;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;

-- Só o cron (e service_role) executa. Nenhum operador, nenhum anônimo: a função
-- escreve notificação para a gestão, e isso não pode ser disparado de fora.
REVOKE ALL ON FUNCTION public.whatsapp_monitorar_sessoes() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.whatsapp_monitorar_sessoes() IS
  'Vigia das sessoes do WhatsApp: avisa a gestao quando um numero fica sem heartbeat alem do limite, 1 aviso por hora, e registra a recuperacao quando volta. Roda a cada 5 min via cron.';

------------------------------------------------------------------------------
-- 4) Agendamento: a cada 5 minutos. Só agenda se pg_cron existir, para a
--    migration não quebrar em ambiente sem a extensão (staging não tem).
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

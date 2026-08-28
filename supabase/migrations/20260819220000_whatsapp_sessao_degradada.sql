-- Central WhatsApp — detectar sessão DEGRADADA (conectada, mas sem receber)
-- =============================================================================
-- O QUE ACONTECEU (2026-08-19, 18:40–18:56): a conexão com o WhatsApp quebrou,
-- mas o gateway continuou reportando CONECTADO e o heartbeat continuou
-- chegando. Durante 15 minutos, mensagem de aluno entrou no WhatsApp e não
-- chegou a lugar nenhum. Ninguém foi avisado — porque o vigia pergunta "o
-- processo está vivo?", e a resposta era sim.
--
-- Só percebemos porque uma imagem enviada de propósito não apareceu.
--
-- POR QUE "X MINUTOS SEM RECEBER" NÃO SERVE: às 22h, no domingo, no almoço, o
-- silêncio é normal. Um alerta que dispara em silêncio natural é ruído, e ruído
-- treina a equipe a ignorar o sino — o que custaria mais caro do que não ter
-- alerta nenhum.
--
-- A REGRA: silêncio de entrada só é suspeito quando há EVIDÊNCIA de que
-- deveria estar entrando mensagem. Duas evidências, e basta uma:
--
--   (a) OS OPERADORES ESTÃO TRABALHANDO — houve saída na janela e nenhuma
--       entrada. Conversa é mão dupla; operador respondendo para o vazio é
--       exatamente a assinatura do defeito.
--
--   (b) O CANAL ESTAVA MOVIMENTADO e parou de repente — recebeu bem na hora
--       anterior e zerou agora.
--
-- CALIBRAGEM COM DADO REAL: no dia do incidente o intervalo mediano entre
-- entradas foi de 1,3 min e o p90 de 8,1 min. Testando esta regra contra as
-- 2h45 de tráfego daquele dia, ela apontou 2 janelas — as duas do incidente — e
-- nenhuma outra. Zero falso positivo, inclusive nos períodos calmos.
--
-- TRÊS ESTADOS DIFERENTES, porque a ação de cada um é outra:
--   SEM_HEARTBEAT -> o serviço caiu; alguém precisa subir a máquina.
--   DESCONECTADO  -> a sessão caiu; reconectar, talvez novo QR.
--   DEGRADADA     -> conectado e mudo; investigar a sessão. É o novo.
-- =============================================================================

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS minutos_sem_entrada_alerta integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS hora_inicio_operacao      integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS hora_fim_operacao         integer NOT NULL DEFAULT 20;

COMMENT ON COLUMN public.whatsapp_config.minutos_sem_entrada_alerta IS
  'Silencio de ENTRADA que levanta suspeita, quando ha evidencia de trafego esperado. Calibrado com dado real: p90 do intervalo entre entradas foi 8,1 min.';

------------------------------------------------------------------------------
-- Horário operacional, no fuso de quem trabalha.
--
-- O banco guarda UTC; a pergunta "estamos em horário de expediente?" só faz
-- sentido em America/Sao_Paulo. Domingo nunca conta.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_em_horario_operacional(p_quando timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH cfg AS (SELECT hora_inicio_operacao AS ini, hora_fim_operacao AS fim FROM public.whatsapp_config LIMIT 1),
  local AS (SELECT p_quando AT TIME ZONE 'America/Sao_Paulo' AS t)
  SELECT CASE
    WHEN extract(dow FROM (SELECT t FROM local)) = 0 THEN false               -- domingo
    WHEN extract(dow FROM (SELECT t FROM local)) = 6                          -- sábado até 14h
      THEN extract(hour FROM (SELECT t FROM local)) BETWEEN (SELECT ini FROM cfg) AND 13
    ELSE extract(hour FROM (SELECT t FROM local))
         BETWEEN (SELECT ini FROM cfg) AND (SELECT fim FROM cfg) - 1
  END;
$$;

------------------------------------------------------------------------------
-- O diagnóstico de um canal.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_diagnostico_canal(p_canal_id uuid)
RETURNS TABLE (
  estado              text,     -- SAUDAVEL | SEM_HEARTBEAT | DESCONECTADO | DEGRADADA
  minutos_sem_entrada numeric,
  entradas_na_janela  integer,
  saidas_na_janela    integer,
  entradas_hora_antes integer,
  em_horario          boolean,
  motivo_evidencia    text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k          public.whatsapp_canais%ROWTYPE;
  v_janela   integer;
  v_hb       integer;
  v_ent      integer;
  v_sai      integer;
  v_ent_ant  integer;
  v_ultima   timestamptz;
  v_horario  boolean;
BEGIN
  SELECT * INTO k FROM public.whatsapp_canais WHERE id = p_canal_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT coalesce(minutos_sem_entrada_alerta, 15), coalesce(minutos_sem_heartbeat_alerta, 5)
    INTO v_janela, v_hb FROM public.whatsapp_config LIMIT 1;

  SELECT count(*) FILTER (WHERE m.direcao = 'ENTRADA'),
         count(*) FILTER (WHERE m.direcao = 'SAIDA')
    INTO v_ent, v_sai
  FROM public.whatsapp_mensagens m
  JOIN public.whatsapp_conversas c ON c.id = m.conversa_id
  WHERE c.canal_id = p_canal_id
    AND m.criado_em > now() - make_interval(mins => v_janela);

  SELECT count(*) INTO v_ent_ant
  FROM public.whatsapp_mensagens m
  JOIN public.whatsapp_conversas c ON c.id = m.conversa_id
  WHERE c.canal_id = p_canal_id AND m.direcao = 'ENTRADA'
    AND m.criado_em > now() - interval '1 hour'
    AND m.criado_em <= now() - make_interval(mins => v_janela);

  SELECT max(m.criado_em) INTO v_ultima
  FROM public.whatsapp_mensagens m
  JOIN public.whatsapp_conversas c ON c.id = m.conversa_id
  WHERE c.canal_id = p_canal_id AND m.direcao = 'ENTRADA';

  v_horario := public.whatsapp_em_horario_operacional();

  entradas_na_janela  := v_ent;
  saidas_na_janela    := v_sai;
  entradas_hora_antes := v_ent_ant;
  em_horario          := v_horario;
  minutos_sem_entrada := CASE WHEN v_ultima IS NULL THEN NULL
                              ELSE round(extract(epoch FROM (now() - v_ultima))/60.0, 1) END;
  motivo_evidencia    := NULL;

  -- A ordem importa: o problema mais grave manda.
  IF k.ultimo_heartbeat_em IS NULL
     OR k.ultimo_heartbeat_em < now() - make_interval(mins => v_hb) THEN
    estado := 'SEM_HEARTBEAT';

  ELSIF k.conexao_status <> 'CONECTADO' THEN
    estado := 'DESCONECTADO';

  ELSIF k.conectado_em IS NOT NULL          -- canal que nunca conectou não conta
    AND v_horario
    AND v_ent = 0
    AND (v_sai >= 2 OR v_ent_ant >= 5)
  THEN
    estado := 'DEGRADADA';
    motivo_evidencia := CASE
      WHEN v_sai >= 2 AND v_ent_ant >= 5 THEN 'operadores respondendo e canal vinha movimentado'
      WHEN v_sai >= 2                    THEN 'operadores respondendo e nada entrando'
      ELSE 'canal vinha movimentado e parou de receber'
    END;

  ELSE
    estado := 'SAUDAVEL';
  END IF;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_diagnostico_canal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_diagnostico_canal(uuid) TO authenticated;

COMMENT ON FUNCTION public.whatsapp_diagnostico_canal(uuid) IS
  'Estado real do canal: SAUDAVEL, SEM_HEARTBEAT, DESCONECTADO ou DEGRADADA (conectado mas sem receber). Detecta o caso que o heartbeat sozinho nao pega.';

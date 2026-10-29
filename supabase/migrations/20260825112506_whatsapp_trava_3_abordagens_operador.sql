-- Trava de 3 abordagens por operador/dia.
--
-- Contexto: o Piloto (+55 51 99631-6324) foi banido em 21/08/2026 depois de um
-- lote de 10 abordagens a numeros novos em 40 segundos. O numero e reincidente,
-- e a segunda punicao do WhatsApp costuma ser pior que a primeira. Enquanto ele
-- volta a operar em ATIVO_CONTROLADO, o teto por operador cai de 10 para 3.
--
-- Sao duas coisas diferentes, de proposito:
--   1. o VALOR   -> limite_abordagens_operador = 3 no canal piloto;
--   2. a TRAVA   -> um teto em whatsapp_config que a tela nao consegue furar.
-- Sem (2), qualquer salvamento da tela de cadencia devolve o limite para 10 sem
-- que ninguem perceba: a tela manda os cinco campos de uma vez.

-- 1. O teto. Mora na config global porque vale para a fase, nao para um canal.
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS teto_abordagens_operador integer NOT NULL DEFAULT 3;

ALTER TABLE public.whatsapp_config
  DROP CONSTRAINT IF EXISTS ck_whatsapp_config_teto_operador;
ALTER TABLE public.whatsapp_config
  ADD CONSTRAINT ck_whatsapp_config_teto_operador
  CHECK (teto_abordagens_operador > 0);

COMMENT ON COLUMN public.whatsapp_config.teto_abordagens_operador IS
  'Maximo que a tela de cadencia pode gravar em limite_abordagens_operador. '
  'Subir exige UPDATE deliberado aqui — é o freio da fase de reaquecimento '
  'pos-ban de 21/08/2026.';

-- 2. O valor, so no piloto. UPDATE em UMA coluna: a janela 09:00-20:00 e o teto
-- do canal ficam intactos (passar janela NULL pela RPC apagaria os dois).
UPDATE public.whatsapp_canais
   SET limite_abordagens_operador = 3
 WHERE sessao_chave = 'piloto'
   AND limite_abordagens_operador IS DISTINCT FROM 3;

-- 3. A tela nao fura o teto. Mesma assinatura de antes, defaults inclusive:
-- sem os DEFAULT NULL o CREATE OR REPLACE e recusado (42P13).
CREATE OR REPLACE FUNCTION public.whatsapp_canal_cadencia_salvar(
  p_canal_id uuid,
  p_modo text,
  p_limite_operador integer DEFAULT NULL,
  p_limite_canal integer DEFAULT NULL,
  p_janela_inicio time DEFAULT NULL,
  p_janela_fim time DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_teto integer;
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

  SELECT teto_abordagens_operador INTO v_teto FROM public.whatsapp_config LIMIT 1;
  v_teto := COALESCE(v_teto, 3);

  IF p_limite_operador IS NOT NULL AND p_limite_operador > v_teto THEN
    RAISE EXCEPTION
      'o maximo por operador nesta fase e % conversas novas por dia (pedido: %)',
      v_teto, p_limite_operador
      USING ERRCODE = '42501', DETAIL = 'TETO_ABORDAGENS_OPERADOR';
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

-- NAO tocado de proposito: whatsapp_cadencia_liberar_extra continua podendo
-- somar cota a UM operador num dia, e essa soma ainda passa dos 3. E uma
-- concessao consciente da gestao, caso a caso, registrada com autor e motivo —
-- diferente do limite geral, que e o que voltava sozinho para 10.

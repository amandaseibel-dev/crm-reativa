-- Lead aberto passa a ser unico POR CANAL, nao por telefone.
--
-- POR QUE: `ux_whatsapp_leads_aberto` era UNIQUE (telefone_e164) WHERE status
-- <> 'ENCERRADO'. A tabela ja tinha `canal_id`, mas o indice o ignorava. Com um
-- numero so, ninguem percebeu. Com dois, a mesma pessoa que procura a empresa
-- pelos DOIS numeros so consegue ter lead aberto em UM deles -- o segundo
-- INSERT viola o indice. E a unica constraint do modulo que cruza canais.
--
-- NULLS NOT DISTINCT (Postgres 15+): `canal_id` e NULLABLE e o parametro da RPC
-- tem default NULL. Sem essa clausula, dois leads com canal_id NULL e o mesmo
-- telefone passariam os dois -- justamente a duplicidade que o indice existia
-- para impedir. Com ela, NULL se comporta como um valor: continua havendo no
-- maximo UM lead aberto sem canal por telefone.
--
-- A RPC muda junto, e nao por elegancia: `whatsapp_lead_registrar` procurava o
-- lead existente so por telefone. Corrigir o indice sem corrigir a busca deixa
-- a RPC ACHANDO o lead do outro canal e fazendo UPDATE nele -- com
-- `canal_id = coalesce(p_canal_id, canal_id)`, o lead do canal 1 seria
-- sequestrado para o canal 2 em silencio. O indice deixaria de barrar e o bug
-- viraria corrupcao de dado em vez de erro visivel.
--
-- Producao tem 0 leads hoje: nao ha backfill nem risco de violacao ao criar.

DROP INDEX IF EXISTS public.ux_whatsapp_leads_aberto;

CREATE UNIQUE INDEX ux_whatsapp_leads_aberto
  ON public.whatsapp_leads (canal_id, telefone_e164)
  NULLS NOT DISTINCT
  WHERE (status <> 'ENCERRADO');

CREATE OR REPLACE FUNCTION public.whatsapp_lead_registrar(
  p_telefone text,
  p_nome     text DEFAULT NULL,
  p_canal_id uuid DEFAULT NULL,
  p_assunto  text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_e164 text := public.whatsapp_normalizar_telefone(p_telefone);
  v_id   uuid;
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;
  IF v_e164 IS NULL THEN
    RAISE EXCEPTION 'telefone invalido';
  END IF;

  -- IS NOT DISTINCT FROM espelha exatamente o NULLS NOT DISTINCT do indice:
  -- a RPC procura no mesmo escopo que a constraint protege. Com `=` puro,
  -- canal NULL nunca casaria e a RPC tentaria INSERT contra o proprio indice.
  SELECT id INTO v_id FROM public.whatsapp_leads
  WHERE telefone_e164 = v_e164
    AND status <> 'ENCERRADO'
    AND canal_id IS NOT DISTINCT FROM p_canal_id;

  IF v_id IS NOT NULL THEN
    UPDATE public.whatsapp_leads
    SET nome          = coalesce(nullif(btrim(p_nome), ''), nome),
        assunto       = coalesce(nullif(btrim(p_assunto), ''), assunto),
        canal_id      = coalesce(p_canal_id, canal_id),
        atualizado_em = now()
    WHERE id = v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.whatsapp_leads (telefone_e164, nome, canal_id, assunto, registrado_por)
  VALUES (v_e164, nullif(btrim(p_nome), ''), p_canal_id, nullif(btrim(p_assunto), ''), public.app_email())
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

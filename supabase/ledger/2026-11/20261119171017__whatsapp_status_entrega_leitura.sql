CREATE OR REPLACE FUNCTION public.whatsapp_mensagem_atualizar_status(
  p_wamid  text,
  p_status text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_linhas integer;
BEGIN
  IF p_wamid IS NULL OR btrim(p_wamid) = '' THEN
    RAISE EXCEPTION 'wamid obrigatorio';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('ENTREGUE', 'LIDO') THEN
    RAISE EXCEPTION 'status invalido: %', p_status;
  END IF;

  UPDATE public.whatsapp_mensagens m
     SET status = p_status
   WHERE m.wamid = btrim(p_wamid)
     AND m.direcao = 'SAIDA'
     AND (
           m.status IS NULL
        OR m.status = 'ENVIADO'
        OR (m.status = 'ENTREGUE' AND p_status = 'LIDO')
     );

  GET DIAGNOSTICS v_linhas = ROW_COUNT;
  RETURN v_linhas > 0;
END;
$$;

COMMENT ON FUNCTION public.whatsapp_mensagem_atualizar_status(text, text) IS
  'Grava recibo de entrega/leitura do WhatsApp numa mensagem de SAIDA, por wamid. '
  'So avanca (ENVIADO -> ENTREGUE -> LIDO); nao sobrescreve FALHOU. '
  'Chamada apenas pelo webhook do gateway (service_role).';

REVOKE ALL ON FUNCTION public.whatsapp_mensagem_atualizar_status(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_mensagem_atualizar_status(text, text)
  TO service_role;

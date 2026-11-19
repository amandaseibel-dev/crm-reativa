-- =============================================================================
-- CENTRAL WHATSAPP — STATUS DE ENTREGA E DE LEITURA (os "tracinhos")
--
-- PROBLEMA
--   `whatsapp_mensagens.status` é gravado uma vez, no eco da mensagem
--   ("ENVIADO" = entrou na nossa fila), e nunca mais muda. O operador lê
--   "enviado" como "o aluno recebeu", e não é. O gateway já recebe do WhatsApp
--   os recibos de entrega e de leitura; faltava um caminho para gravá-los.
--
-- O QUE ESTA MIGRATION FAZ
--   Cria UMA função, chamada só pelo webhook do gateway (service_role):
--     public.whatsapp_mensagem_atualizar_status(p_wamid, p_status) -> boolean
--
-- O QUE ELA NÃO FAZ
--   * não cria coluna, tabela, trigger, policy nem índice (`wamid` já é UNIQUE);
--   * não altera função existente — nenhum `CREATE OR REPLACE` sobre objeto
--     que já estava em produção;
--   * não mexe em conversa, contador de não lidas, fila de "sem retorno",
--     cadência nem acionamento: os gatilhos da tabela são AFTER INSERT e não
--     disparam em UPDATE;
--   * não amplia leitura: quem vê a mensagem continua sendo decidido pela
--     policy `whatsapp_mensagens_leitura` e por `whatsapp_mensagens_listar`.
--
-- REGRAS
--   1. Só mensagem de SAÍDA tem tracinho. Recibo de mensagem recebida é
--      ignorado.
--   2. O status só AVANÇA: (nulo|ENVIADO) -> ENTREGUE -> LIDO. Recibo atrasado
--      ou repetido não regride nada (o WhatsApp reentrega recibos).
--   3. FALHOU não é sobrescrito: é o registro do erro que o operador precisa
--      ver, e tem caminho próprio.
--   4. Wamid desconhecido devolve `false`, sem erro: é recibo de mensagem que
--      o CRM não registrou. Erro faria o gateway repetir para sempre.
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.whatsapp_mensagem_atualizar_status(text, text);
--   (os status já gravados como ENTREGUE/LIDO continuam válidos para a coluna,
--    cujo vocabulário documentado sempre foi ENVIADO|ENTREGUE|LIDO|FALHOU.)
-- =============================================================================

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

-- Função nova nasce com EXECUTE para PUBLIC/authenticated pelo default do
-- schema. Esta é escrita de sistema: nenhum usuário logado pode chamá-la.
REVOKE ALL ON FUNCTION public.whatsapp_mensagem_atualizar_status(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_mensagem_atualizar_status(text, text)
  TO service_role;

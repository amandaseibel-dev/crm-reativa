-- Central WhatsApp — avisar o operador quando chega mensagem
-- =============================================================================
-- O BURACO: hoje ninguém é notificado quando um aluno escreve. O operador só
-- descobre se estiver com a Central ABERTA — o badge e o som vivem na tela. Se
-- ele estiver na carteira, na agenda ou em qualquer outra parte do CRM, a
-- mensagem espera sem que ninguém saiba.
--
-- Nada disso aparece como erro: a conversa entra certinho na fila "Sem retorno"
-- e fica lá, quieta. É o tipo de falha que só se manifesta como aluno reclamando
-- que ninguém respondeu.
--
-- QUEM É AVISADO:
--   * conversa COM responsável -> só ele. É o atendimento dele.
--   * conversa SEM responsável -> todos os operadores ativos, porque ninguém
--     ainda assumiu e alguém precisa pegar. É o mesmo raciocínio da fila
--     "Aguardando atendimento", só que empurrado em vez de esperado.
--
-- UMA NOTIFICAÇÃO POR CONVERSA, NÃO POR MENSAGEM. Aluno que manda cinco linhas
-- seguidas geraria cinco sinos, e sino demais é sino ignorado. Enquanto houver
-- aviso NÃO LIDO daquela conversa, não se cria outro.
--
-- HISTÓRICO IMPORTADO NUNCA NOTIFICA. Já valia para o contador de não lidas;
-- vale igual aqui. Um pareamento com milhares de mensagens antigas não pode
-- disparar milhares de avisos.
-- =============================================================================

CREATE OR REPLACE FUNCTION public._trg_whatsapp_notificar_mensagem()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv    public.whatsapp_conversas%ROWTYPE;
  v_quem    text;
  v_titulo  text;
  v_previa  text;
BEGIN
  -- Só mensagem do aluno, chegando agora.
  IF new.direcao <> 'ENTRADA' OR coalesce(new.origem, '') = 'SYNC_INICIAL' THEN
    RETURN new;
  END IF;

  SELECT * INTO v_conv FROM public.whatsapp_conversas WHERE id = new.conversa_id;
  IF NOT FOUND THEN RETURN new; END IF;

  -- Já existe aviso não lido desta conversa? Então o sino já está tocando.
  IF EXISTS (
    SELECT 1 FROM public.notificacoes n
    WHERE n.tipo = 'WHATSAPP_MENSAGEM'
      AND n.lida = false
      AND n.url_destino = '/central-whatsapp'
      AND n.mensagem LIKE '%' || v_conv.telefone_e164 || '%'
  ) THEN
    RETURN new;
  END IF;

  v_quem := coalesce(
    nullif(v_conv.aluno_nome, ''),
    nullif(v_conv.nome_perfil, ''),
    v_conv.telefone_e164
  );
  v_titulo := '💬 ' || v_quem;
  -- Prévia curta: o sino diz QUEM e dá o começo, nunca a mensagem inteira.
  v_previa := left(coalesce(nullif(btrim(new.texto), ''), '[' || coalesce(new.tipo, 'anexo') || ']'), 90);

  IF v_conv.responsavel_email IS NOT NULL THEN
    INSERT INTO public.notificacoes (
      usuario_destino_email, usuario_destino_nome, tipo, titulo, mensagem,
      url_destino, lida, criado_em
    ) VALUES (
      lower(v_conv.responsavel_email), v_conv.responsavel_nome, 'WHATSAPP_MENSAGEM',
      v_titulo,
      v_previa || ' — ' || v_conv.telefone_e164,
      '/central-whatsapp', false, now()
    );
  ELSE
    INSERT INTO public.notificacoes (
      usuario_destino_email, usuario_destino_nome, tipo, titulo, mensagem,
      url_destino, lida, criado_em
    )
    SELECT lower(u.email), u.nome, 'WHATSAPP_MENSAGEM',
           v_titulo || ' (sem responsável)',
           v_previa || ' — ' || v_conv.telefone_e164,
           '/central-whatsapp', false, now()
    FROM public.usuarios u
    WHERE u.ativo;
  END IF;

  RETURN new;
END;
$$;

REVOKE ALL ON FUNCTION public._trg_whatsapp_notificar_mensagem() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._trg_whatsapp_notificar_mensagem() IS
  'Avisa o operador quando chega mensagem do aluno. Um aviso por conversa enquanto houver nao lido; historico importado nunca notifica.';

DROP TRIGGER IF EXISTS trg_whatsapp_notificar_mensagem ON public.whatsapp_mensagens;
CREATE TRIGGER trg_whatsapp_notificar_mensagem
  AFTER INSERT ON public.whatsapp_mensagens
  FOR EACH ROW
  EXECUTE FUNCTION public._trg_whatsapp_notificar_mensagem();

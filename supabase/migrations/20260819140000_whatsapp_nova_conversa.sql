-- Central WhatsApp — abrir conversa nova (operador inicia o contato)
-- =============================================================================
-- O QUE FALTAVA: até aqui a Central só sabia RESPONDER. Toda conversa nascia de
-- uma mensagem do aluno; não havia caminho para o operador iniciar o contato.
-- Na prática isso empurrava o operador de volta para o celular ou para o
-- WhatsApp Web — exatamente o que este módulo existe para evitar. E o que sai
-- por fora não fica no histórico da Central, não tem responsável e não entra na
-- supervisão.
--
-- DUAS FUNÇÕES, COM PAPÉIS DIFERENTES:
--
--   `whatsapp_conversa_por_telefone` — consulta barata, sem efeito colateral.
--   A tela chama enquanto o operador digita o número, para avisar ANTES que já
--   existe conversa com aquela pessoa (e de quem ela é). Sem isso o operador
--   descobriria só depois de escrever a mensagem, ou pior: abriria um segundo
--   atendimento paralelo ao de um colega.
--
--   `whatsapp_preparar_envio_novo` — o gêmeo de `whatsapp_preparar_envio` para
--   quem ainda não tem conversa. Cria (ou reaproveita), assume, e devolve por
--   qual sessão o gateway deve falar.
--
-- POR QUE A CONVERSA NASCE AQUI E NÃO NA TELA: se a tela criasse a conversa ao
-- abrir o formulário, todo operador que desistisse no meio deixaria uma
-- conversa vazia na caixa de entrada. Aqui ela só nasce dentro do envio — e se
-- o envio falhar, a Edge Function grava a mensagem como `FALHOU`, então a
-- conversa nunca fica muda: ou tem a mensagem, ou tem o registro do erro.
--
-- REGRA DE DONO PRESERVADA: se já existe conversa e ela é de outro operador,
-- isto RECUSA, com o nome de quem está atendendo. "Nova conversa" não pode
-- virar a porta dos fundos para furar a trava de responsável.
--
-- O QUE NÃO MUDA: o número de saída continua vindo do BANCO, nunca do
-- frontend. A tela manda `canal_id`; quem traduz para `sessao_chave` é daqui.
-- =============================================================================

------------------------------------------------------------------------------
-- 1) Já existe conversa com este número neste canal?
--
--    Só leitura. Devolve zero ou uma linha. Não identifica aluno nem carrega
--    ficha: é chamada a cada tecla do operador e precisa ser barata.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_conversa_por_telefone(
  p_canal_id uuid,
  p_telefone text
)
RETURNS TABLE (
  conversa_id        uuid,
  telefone_e164      text,
  status             text,
  responsavel_email  text,
  responsavel_nome   text,
  aluno_id           uuid,
  aluno_nome         text,
  ultima_mensagem_em timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_e164 text := public.whatsapp_normalizar_telefone(p_telefone);
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  IF v_e164 IS NULL OR p_canal_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.id, c.telefone_e164, c.status, c.responsavel_email, c.responsavel_nome,
         c.aluno_id, c.aluno_nome, c.ultima_mensagem_em
  FROM public.whatsapp_conversas c
  WHERE c.canal_id = p_canal_id AND c.telefone_e164 = v_e164;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_conversa_por_telefone(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_conversa_por_telefone(uuid,text) TO authenticated;

COMMENT ON FUNCTION public.whatsapp_conversa_por_telefone(uuid,text) IS
  'Consulta barata: ja existe conversa com este telefone neste canal? Usada enquanto o operador digita, antes de abrir conversa nova.';

------------------------------------------------------------------------------
-- 2) Preparar o envio de uma conversa que ainda não existe.
--
--    Espelha `whatsapp_preparar_envio` nas travas (usuário ativo, canal ativo e
--    conectado, dono da conversa) e acrescenta a criação.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_preparar_envio_novo(
  p_canal_id uuid,
  p_telefone text,
  p_aluno_id uuid DEFAULT NULL
)
RETURNS TABLE (
  conversa_id    uuid,
  sessao_chave   text,
  telefone_e164  text,
  operador_email text,
  ja_existia     boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Telefone inválido falha ANTES de qualquer escrita. Número torto vira
  -- conversa que nunca recebe resposta e ninguém entende por quê.
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

  -- Trava a linha para que dois operadores clicando "Enviar" ao mesmo tempo não
  -- criem duas conversas para o mesmo número.
  -- Alias obrigatório: `telefone_e164` e `conversa_id` também são nomes de
  -- parâmetro de saída desta função (RETURNS TABLE). Sem qualificar, o PL/pgSQL
  -- não sabe se a referência é da coluna ou do parâmetro e recusa a consulta.
  SELECT c.* INTO v_conv
  FROM public.whatsapp_conversas c
  WHERE c.canal_id = p_canal_id AND c.telefone_e164 = v_e164
  FOR UPDATE;

  IF FOUND THEN
    -- Já existe: "Nova conversa" NÃO fura a trava de responsável.
    IF v_conv.responsavel_email IS NOT NULL
       AND v_conv.responsavel_email <> v_email
       AND NOT public.usuario_e_gestao() THEN
      RAISE EXCEPTION 'ja existe conversa com este numero, em atendimento por %',
        coalesce(v_conv.responsavel_nome, v_conv.responsavel_email) USING ERRCODE = '42501';
    END IF;

    v_id := v_conv.id;

    UPDATE public.whatsapp_conversas c
    SET responsavel_email = coalesce(c.responsavel_email, v_email),
        responsavel_nome  = coalesce(c.responsavel_nome, v_nome, v_email),
        responsavel_desde = coalesce(c.responsavel_desde, now()),
        -- Conversa encerrada volta a atender: quem escreve de novo reabriu.
        status            = CASE WHEN c.status = 'ENCERRADO' THEN 'EM_ATENDIMENTO' ELSE c.status END,
        -- Vínculo explícito de aluno vence palpite: se o operador escolheu a
        -- pessoa na busca, é essa.
        aluno_id          = coalesce(p_aluno_id, c.aluno_id),
        atualizado_em     = now()
    WHERE c.id = v_id;

  ELSE
    v_novo := true;

    -- Identificação do aluno roda UMA vez, no nascimento da conversa — igual ao
    -- caminho de mensagem recebida. É consulta cara (varre `alunos`) e não pode
    -- virar rotina.
    SELECT * INTO v_ident FROM public.whatsapp_identificar_aluno(v_e164);

    INSERT INTO public.whatsapp_conversas (
      canal_id, telefone_e164, nome_perfil, status,
      aluno_id, aluno_nome, aluno_status, aluno_candidatos, aluno_identificado_em,
      origem_sync,
      responsavel_email, responsavel_nome, responsavel_desde
    ) VALUES (
      p_canal_id, v_e164, NULL, 'EM_ATENDIMENTO',
      coalesce(p_aluno_id, v_ident.aluno_id), v_ident.aluno_nome, v_ident.situacao,
      v_ident.candidatos, now(),
      false,
      v_email, coalesce(v_nome, v_email), now()
    )
    RETURNING id INTO v_id;
  END IF;

  RETURN QUERY SELECT v_id, v_canal.sessao_chave, v_e164, v_email, NOT v_novo;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_preparar_envio_novo(uuid,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_preparar_envio_novo(uuid,text,uuid) TO authenticated;

COMMENT ON FUNCTION public.whatsapp_preparar_envio_novo(uuid,text,uuid) IS
  'Gemeo de whatsapp_preparar_envio para conversa que ainda nao existe: cria, assume e devolve a sessao de saida. Recusa se o numero estiver fora do ar ou se a conversa for de outro operador.';

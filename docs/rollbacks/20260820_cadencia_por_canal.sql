-- ROLLBACK da cadencia por canal:
--   20260820150000_whatsapp_cadencia_por_canal.sql
--   20260820150100_acoes_massivas_whatsapp_bloqueado.sql
--
-- ORDEM IMPORTA: os dois portoes voltam a versao sem cadencia ANTES de
-- `whatsapp_cadencia_checar` sumir. Na ordem inversa, todo envio quebraria com
-- "function does not exist" ate a linha seguinte rodar -- e o modulo inteiro
-- ficaria mudo nesse intervalo.
--
-- O QUE SOBREVIVE: `whatsapp_abordagens` e `whatsapp_cadencia_bloqueios` NAO
-- sao apagadas. Sao o historico que justifica subir ou descer os limites; jogar
-- fora seria perder justamente a medicao que motivou a fase. Ficam ortas e
-- inofensivas -- nada mais escreve nelas.
--
-- As colunas de configuracao em `whatsapp_canais` tambem ficam: sao inertes sem
-- as funcoes que as leem, e preservam o que a gestao havia configurado caso a
-- cadencia volte.

-- ===================== 1. portoes sem cadencia ==============================
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
  p_canal_id uuid, p_telefone text, p_aluno_id uuid DEFAULT NULL::uuid)
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
  END IF;

  RETURN QUERY SELECT v_id, v_canal.sessao_chave, v_e164, v_email, NOT v_novo;
END;
$function$;

-- ===================== 2. Acoes Massivas volta a aceitar WhatsApp ===========
-- Mesma cirurgia da ida, ao contrario: le a definicao VIVA e remove a guarda.
DO $rollback$
DECLARE
  v_def text;
  v_guarda text := '

  -- Vale inclusive para o executor tecnico: se algum automatismo chamar com
  -- WHATSAPP, e melhor falhar alto do que disparar em massa por fora do teto.
  IF upper(coalesce(p_canal, '''')) = ''WHATSAPP'' THEN
    RAISE EXCEPTION ''Acoes Massivas por WhatsApp estao suspensas: o disparo sai fora do controle de cadencia e nao entra no teto diario do numero. Use a Central para iniciar conversas.''
      USING ERRCODE = ''42501'';
  END IF;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'registrar_acao_massiva';

  IF v_def IS NULL THEN
    RAISE NOTICE 'registrar_acao_massiva nao existe aqui; nada a reverter';
    RETURN;
  END IF;

  IF position(v_guarda IN v_def) = 0 THEN
    RAISE NOTICE 'guarda nao encontrada; nada a reverter';
    RETURN;
  END IF;

  EXECUTE replace(v_def, v_guarda, '');
END;
$rollback$;

-- ===================== 3. so entao as funcoes de cadencia ===================
DROP FUNCTION IF EXISTS public.whatsapp_cadencia_checar(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.whatsapp_cadencia_consumo();
DROP FUNCTION IF EXISTS public.whatsapp_cadencia_registrar_bloqueio(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.whatsapp_canal_cadencia_salvar(uuid, text, integer, integer, time, time);
DROP FUNCTION IF EXISTS public.whatsapp_cadencia_indicadores(integer);

-- As tabelas e as colunas de configuracao ficam de proposito (ver cabecalho).
-- Para descartar tambem o historico, e so rodar:
--   DROP TABLE public.whatsapp_abordagens, public.whatsapp_cadencia_bloqueios;
--   ALTER TABLE public.whatsapp_canais
--     DROP COLUMN modo, DROP COLUMN limite_abordagens_operador,
--     DROP COLUMN limite_abordagens_canal, DROP COLUMN janela_inicio,
--     DROP COLUMN janela_fim, DROP COLUMN modo_alterado_em,
--     DROP COLUMN modo_alterado_por;

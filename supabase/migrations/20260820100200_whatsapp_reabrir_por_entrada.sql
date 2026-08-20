-- Entrada nova do aluno DESARQUIVA. Saida nossa, nao.
--
-- POR QUE ISTO NAO CONTRARIA "arquivamento e manual": arquivar continua sendo
-- decisao exclusiva do operador. O que reabre e uma DEMANDA NOVA do aluno.
-- Engolir isso repetiria o modo de falha que ja custou 5.800 mensagens neste
-- projeto: perda silenciosa. Arquivar nao pode virar buraco.
--
-- `NOT v_sync` de proposito: importacao de historico NAO e demanda nova, e
-- desarquivaria em massa num repareamento. Segue a mesma regra que ja vale
-- para `nao_lidas`.
--
-- A funcao inteira e recriada porque a unica forma de alterar duas linhas de um
-- UPDATE em plpgsql e reescrever o corpo. A mudanca esta so nas linhas
-- `arquivada_em` e `arquivada_por`.
--
-- Aplicada e testada em staging. Ainda NAO em producao.
create or replace function public.whatsapp_registrar_mensagem(
  p_sessao_chave text, p_telefone text, p_nome_perfil text, p_wamid text,
  p_direcao text, p_tipo text, p_texto text, p_midia_id text, p_midia_mime text,
  p_timestamp timestamptz, p_payload jsonb, p_origem text default 'TEMPO_REAL',
  p_enviado_por text default null, p_status text default null)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
DECLARE
  v_canal_id    uuid;
  v_conversa_id uuid;
  v_e164        text := public.whatsapp_normalizar_telefone(p_telefone);
  v_previa      text;
  v_ident       record;
  v_ts          timestamptz := coalesce(p_timestamp, now());
  v_sync        boolean := (coalesce(p_origem,'TEMPO_REAL') = 'SYNC_INICIAL');
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR auth.jwt() IS NULL) THEN
    RAISE EXCEPTION 'whatsapp_registrar_mensagem: acesso negado' USING ERRCODE = '42501';
  END IF;
  IF p_direcao NOT IN ('ENTRADA','SAIDA') THEN
    RAISE EXCEPTION 'direcao invalida: %', p_direcao;
  END IF;

  SELECT id INTO v_canal_id FROM public.whatsapp_canais WHERE sessao_chave = p_sessao_chave;
  IF v_canal_id IS NULL THEN
    RAISE EXCEPTION 'canal desconhecido para sessao %', p_sessao_chave;
  END IF;
  IF v_e164 IS NULL THEN
    RAISE EXCEPTION 'telefone invalido: %', p_telefone;
  END IF;

  SELECT id INTO v_conversa_id FROM public.whatsapp_conversas
  WHERE canal_id = v_canal_id AND telefone_e164 = v_e164;

  IF v_conversa_id IS NULL THEN
    SELECT * INTO v_ident FROM public.whatsapp_identificar_aluno(v_e164);
    INSERT INTO public.whatsapp_conversas (
      canal_id, telefone_e164, nome_perfil, status,
      aluno_id, aluno_nome, aluno_status, aluno_candidatos, aluno_identificado_em, origem_sync
    ) VALUES (
      v_canal_id, v_e164, p_nome_perfil, 'NOVO',
      v_ident.aluno_id, v_ident.aluno_nome, v_ident.situacao, v_ident.candidatos, now(), v_sync
    ) RETURNING id INTO v_conversa_id;
  END IF;

  v_previa := left(coalesce(nullif(btrim(p_texto), ''), '[' || coalesce(p_tipo, 'midia') || ']'), 120);

  INSERT INTO public.whatsapp_mensagens (
    conversa_id, wamid, direcao, tipo, texto, midia_id, midia_mime,
    status, enviado_por_email, origem, timestamp_wa, payload
  ) VALUES (
    v_conversa_id, p_wamid, p_direcao, coalesce(p_tipo, 'text'), p_texto,
    p_midia_id, p_midia_mime, p_status, p_enviado_por,
    coalesce(p_origem, 'TEMPO_REAL'), v_ts, p_payload
  ) ON CONFLICT (wamid) DO NOTHING;

  IF NOT FOUND THEN
    RETURN v_conversa_id;
  END IF;

  UPDATE public.whatsapp_conversas
  SET ultima_mensagem_em     = greatest(coalesce(ultima_mensagem_em, v_ts), v_ts),
      ultima_mensagem_previa = CASE
                                 WHEN ultima_mensagem_em IS NULL OR v_ts >= ultima_mensagem_em
                                 THEN v_previa ELSE ultima_mensagem_previa END,
      nome_perfil            = coalesce(p_nome_perfil, nome_perfil),
      nao_lidas              = CASE
                                 WHEN p_direcao = 'ENTRADA' AND NOT v_sync THEN nao_lidas + 1
                                 WHEN p_direcao = 'SAIDA'                  THEN 0
                                 ELSE nao_lidas END,
      status                 = CASE
                                 WHEN p_direcao = 'ENTRADA' AND status = 'ENCERRADO' THEN 'NOVO'
                                 WHEN p_direcao = 'SAIDA'   AND status = 'NOVO'      THEN 'RESPONDIDO'
                                 ELSE status END,
      -- >>> reabertura por demanda do aluno <<<
      arquivada_em           = CASE WHEN p_direcao = 'ENTRADA' AND NOT v_sync
                                    THEN NULL ELSE arquivada_em END,
      arquivada_por          = CASE WHEN p_direcao = 'ENTRADA' AND NOT v_sync
                                    THEN NULL ELSE arquivada_por END,
      atualizado_em          = now()
  WHERE id = v_conversa_id;

  RETURN v_conversa_id;
END;
$function$;

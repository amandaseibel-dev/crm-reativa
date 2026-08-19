-- Central WhatsApp — recepção de mídia (imagem, documento, áudio)
-- =============================================================================
-- O QUE FALTAVA: a fase 1 registrava só a REFERÊNCIA da mídia — o operador via
-- "[image]" e nada mais. Na prática, todo comprovante que o aluno mandava se
-- perdia do ponto de vista da Central, que é justamente o que esta operação
-- mais recebe. Três imagens reais já chegaram assim em 2026-08-19, uma delas
-- com legenda perguntando sobre um débito.
--
-- DECISÕES (Amanda, 2026-08-19):
--   * bucket PRIVADO próprio; no banco fica só o `midia_path`, NUNCA uma URL —
--     nem pública nem assinada. A URL é gerada sob demanda, na hora do clique,
--     e vence em segundos;
--   * imagem, documento e áudio nesta fase. Vídeo fora;
--   * retenção de 12 meses, igual à das mensagens, e o expurgo tem de levar o
--     ARQUIVO junto — mídia órfã em bucket é dado de aluno sem dono;
--   * só recepção. Envio de mídia pela Central não entra agora.
--
-- POR QUE O GATEWAY NÃO ESCREVE DIRETO NO STORAGE: ele não tem credencial de
-- banco, de propósito — se aquela máquina for invadida, o atacante não ganha o
-- Supabase. Manter isso vale mais do que economizar um salto: a mídia vai do
-- gateway para a Edge Function `whatsapp-midia` (autenticada por HMAC) e é ela,
-- no servidor, quem grava no bucket.
-- =============================================================================

------------------------------------------------------------------------------
-- 1) O bucket. Privado — sem exceção.
------------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'whatsapp-midia',
  'whatsapp-midia',
  false,
  20971520,  -- 20 MB: teto duro no próprio bucket, além do teto do gateway
  ARRAY[
    'image/jpeg','image/png','image/webp','image/gif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain','text/csv',
    'audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/amr','audio/wav'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

------------------------------------------------------------------------------
-- 2) Quem enxerga o arquivo.
--
--    LEITURA: só usuário ativo do CRM — a mesma porta de todo o módulo. É isso
--    que permite a Central pedir uma URL assinada na hora do clique sem que o
--    arquivo fique acessível a mais ninguém.
--
--    ESCRITA: ninguém além do service_role. O upload acontece na Edge Function;
--    nem operador nem gestão escrevem neste bucket, e não há caminho de upload
--    pela Central nesta fase.
------------------------------------------------------------------------------
DROP POLICY IF EXISTS "whatsapp midia leitura crm" ON storage.objects;
CREATE POLICY "whatsapp midia leitura crm"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'whatsapp-midia' AND public.app_usuario_ativo());

-- Sem policy de INSERT/UPDATE/DELETE para `authenticated`: a ausência é a
-- proteção. `service_role` ignora RLS e é quem grava.

------------------------------------------------------------------------------
-- 3) Metadados da mídia na mensagem.
--
--    `midia_path` já existia (previsto e nunca preenchido). Faltava o resto:
--    nome original do documento, tamanho, e o MOTIVO quando o download falha.
------------------------------------------------------------------------------
ALTER TABLE public.whatsapp_mensagens ADD COLUMN IF NOT EXISTS midia_nome     text;
ALTER TABLE public.whatsapp_mensagens ADD COLUMN IF NOT EXISTS midia_tamanho  bigint;
ALTER TABLE public.whatsapp_mensagens ADD COLUMN IF NOT EXISTS midia_erro     text;

COMMENT ON COLUMN public.whatsapp_mensagens.midia_path IS
  'Caminho no bucket privado whatsapp-midia. NUNCA uma URL: a assinada e gerada sob demanda e vence em segundos.';
COMMENT ON COLUMN public.whatsapp_mensagens.midia_erro IS
  'Por que o anexo nao pode ser recuperado. A mensagem entra na Central assim mesmo, com o aviso visivel.';

------------------------------------------------------------------------------
-- 4) Registrar o resultado do download.
--
--    Chamada pela Edge Function depois de gravar (ou falhar ao gravar) o
--    arquivo. Idempotente por `wamid`: reentrega do gateway não duplica nada.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_midia_registrar(
  p_wamid    text,
  p_path     text DEFAULT NULL,
  p_mime     text DEFAULT NULL,
  p_tamanho  bigint DEFAULT NULL,
  p_nome     text DEFAULT NULL,
  p_erro     text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR auth.jwt() IS NULL) THEN
    RAISE EXCEPTION 'whatsapp_midia_registrar: acesso negado' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_id FROM public.whatsapp_mensagens WHERE wamid = p_wamid;
  IF v_id IS NULL THEN
    -- A mensagem ainda não chegou (a mídia é enviada fora da fila ordenada, de
    -- propósito, para nunca segurar mensagem de texto atrás dela). Quem chamou
    -- tenta de novo.
    RETURN false;
  END IF;

  UPDATE public.whatsapp_mensagens
  SET midia_path    = coalesce(p_path, midia_path),
      midia_mime    = coalesce(p_mime, midia_mime),
      midia_tamanho = coalesce(p_tamanho, midia_tamanho),
      midia_nome    = coalesce(p_nome, midia_nome),
      midia_erro    = p_erro
  WHERE id = v_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_midia_registrar(text,text,text,bigint,text,text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.whatsapp_midia_registrar(text,text,text,bigint,text,text) IS
  'Grava o resultado do download da midia na mensagem. Chamada pela Edge Function whatsapp-midia (service_role).';

------------------------------------------------------------------------------
-- 5) Expurgo levando o ARQUIVO junto.
--
--    DESCOBERTO NO TESTE: o Supabase PROÍBE `DELETE FROM storage.objects` por
--    SQL — há um gatilho `storage.protect_delete()` que recusa, justamente para
--    não deixar arquivo órfão no bucket enquanto o registro some. A remoção só
--    vale pela API de Storage.
--
--    Então a ordem é: o expurgo ANOTA os caminhos numa fila de remoção e só
--    depois apaga as mensagens. Quem tem a chave de serviço — a Edge Function
--    `whatsapp-midia` — drena essa fila pela API. Assim o caminho nunca se
--    perde antes do arquivo sair, que é o que evita a mídia órfã.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_midia_expurgo (
  path        text PRIMARY KEY,
  anotado_em  timestamptz NOT NULL DEFAULT now(),
  removido_em timestamptz,
  tentativas  integer NOT NULL DEFAULT 0,
  erro        text
);

ALTER TABLE public.whatsapp_midia_expurgo ENABLE ROW LEVEL SECURITY;
-- Sem policy: só service_role enxerga. É lista de caminho de arquivo de aluno.

COMMENT ON TABLE public.whatsapp_midia_expurgo IS
  'Arquivos a remover do bucket depois do expurgo de 12 meses. Existe porque o Storage nao aceita DELETE por SQL; a Edge Function drena pela API.';

-- Ganhou uma coluna no retorno (`midias_anotadas`), e o Postgres não deixa
-- trocar o tipo de retorno com CREATE OR REPLACE. Só o cron a executa.
DROP FUNCTION IF EXISTS public.whatsapp_expurgar_retencao();

CREATE FUNCTION public.whatsapp_expurgar_retencao()
RETURNS TABLE (
  mensagens_apagadas integer,
  conversas_apagadas integer,
  leads_apagados     integer,
  midias_anotadas    integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_msg    integer := 0;
  v_conv   integer := 0;
  v_leads  integer := 0;
  v_midia  integer := 0;
  v_corte  timestamptz := now() - interval '12 months';
BEGIN
  -- ANOTA O ARQUIVO ANTES. Apagar a mensagem primeiro apagaria junto a única
  -- pista de qual arquivo remover, e ele ficaria no bucket para sempre.
  INSERT INTO public.whatsapp_midia_expurgo (path)
  SELECT m.midia_path FROM public.whatsapp_mensagens m
  WHERE m.midia_path IS NOT NULL AND m.timestamp_wa < v_corte
  ON CONFLICT (path) DO NOTHING;
  GET DIAGNOSTICS v_midia = ROW_COUNT;

  DELETE FROM public.whatsapp_mensagens WHERE timestamp_wa < v_corte;
  GET DIAGNOSTICS v_msg = ROW_COUNT;

  DELETE FROM public.whatsapp_conversas
  WHERE coalesce(ultima_mensagem_em, criado_em) < v_corte;
  GET DIAGNOSTICS v_conv = ROW_COUNT;

  -- `registrado_em`, não `criado_em`: escrevi errado na primeira versão e o
  -- expurgo mensal teria quebrado em produção. O teste em staging pegou.
  DELETE FROM public.whatsapp_leads WHERE registrado_em < v_corte;
  GET DIAGNOSTICS v_leads = ROW_COUNT;

  mensagens_apagadas := v_msg;
  conversas_apagadas := v_conv;
  leads_apagados     := v_leads;
  midias_anotadas    := v_midia;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_expurgar_retencao() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.whatsapp_expurgar_retencao() IS
  'Retencao LGPD de 12 meses da Central WhatsApp. Anota o arquivo na fila de remocao ANTES de apagar a mensagem, para nao deixar midia orfa. Roda mensal via cron.';

------------------------------------------------------------------------------
-- 5.1) A fila de remoção, para quem tem a chave de serviço drenar.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_midia_a_remover(p_limite integer DEFAULT 100)
RETURNS TABLE (path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR auth.jwt() IS NULL) THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT e.path FROM public.whatsapp_midia_expurgo e
    WHERE e.removido_em IS NULL AND e.tentativas < 5
    ORDER BY e.anotado_em
    LIMIT greatest(1, least(coalesce(p_limite, 100), 500));
END;
$$;

CREATE OR REPLACE FUNCTION public.whatsapp_midia_removida(p_path text, p_erro text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR auth.jwt() IS NULL) THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;
  UPDATE public.whatsapp_midia_expurgo
  SET removido_em = CASE WHEN p_erro IS NULL THEN now() ELSE NULL END,
      tentativas  = tentativas + 1,
      erro        = p_erro
  WHERE path = p_path;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_midia_a_remover(integer)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_midia_removida(text,text)  FROM PUBLIC, anon, authenticated;

------------------------------------------------------------------------------
-- 6) A listagem de mensagens precisa devolver os campos novos, senão a Central
--    não tem como exibir o anexo.
------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.whatsapp_mensagens_listar(uuid, integer);

CREATE OR REPLACE FUNCTION public.whatsapp_mensagens_listar(
  p_conversa_id uuid,
  p_limite      integer DEFAULT 200
)
-- Os campos antigos permanecem, na mesma ordem: a Central em produção depende
-- deles. Os de mídia entram DEPOIS, para nenhum consumidor existente quebrar.
RETURNS TABLE (
  id                uuid,
  direcao           text,
  tipo              text,
  texto             text,
  midia_id          text,
  midia_mime        text,
  status            text,
  erro_detalhe      text,
  enviado_por_email text,
  origem            text,
  timestamp_wa      timestamptz,
  midia_path        text,
  midia_nome        text,
  midia_tamanho     bigint,
  midia_erro        text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.direcao, m.tipo, m.texto,
         m.midia_id, m.midia_mime,
         m.status, m.erro_detalhe, m.enviado_por_email, m.origem, m.timestamp_wa,
         m.midia_path, m.midia_nome, m.midia_tamanho, m.midia_erro
  FROM public.whatsapp_mensagens m
  WHERE public.app_usuario_ativo()
    AND m.conversa_id = p_conversa_id
  ORDER BY m.timestamp_wa DESC
  LIMIT greatest(1, least(coalesce(p_limite, 200), 500));
$$;

REVOKE ALL ON FUNCTION public.whatsapp_mensagens_listar(uuid,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_mensagens_listar(uuid,integer) TO authenticated;

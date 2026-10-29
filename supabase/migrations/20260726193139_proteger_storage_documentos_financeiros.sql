-- Remediação de segurança (LGPD): proteger `comprovantes-pagamento` e `termos-acordo`.
-- -----------------------------------------------------------------------------
-- Antes: buckets já PRIVADOS, porém com policies AMPLAS: qualquer usuário
-- AUTENTICADO tinha SELECT/INSERT/UPDATE sobre TODO o bucket (só filtrava
-- bucket_id). Como o banco guardava URL pública e o navegador chamava
-- createSignedUrl, um operador conseguia assinar/ENUMERAR comprovantes e termos
-- de QUALQUER aluno/registro (acesso cruzado indevido a documento financeiro).
--
-- Depois:
--   1) removidas as policies amplas (ver/upload/atualizar) dos 2 buckets;
--   2) SEM policy SELECT para authenticated => cliente não lê nem lista (zero
--      enumeração, mesmo logado); leitura só via Edge Function
--      `documento-financeiro-url` (service role no servidor), que valida vínculo
--      e assina URL de curta duração (TTL 300s);
--   3) SEM policy de INSERT para authenticated: o upload é autorizado caso a
--      caso pela Edge Function (signed upload URL + tabela de INTENÇÕES, caminho
--      com UUID resolvido no servidor) — cliente não escolhe bucket/pasta/nome;
--   4) UPDATE e DELETE restritos à GESTÃO financeira (usuario_e_gestao()) e
--      usuário ativo — impede que um operador substitua/apague documento de
--      outro registro. Uploads usam upsert:false (não sobrescrevem);
--   5) limite de tamanho e MIME alinhados ao que o front realmente envia.
--
-- Reusa controles centrais: public.perfil_do_usuario_atual() (cadastrado+ativo)
-- e public.usuario_e_gestao(). postgres e service_role preservados (service_role
-- ignora RLS). NÃO exclui nenhum objeto do Storage. NÃO altera dados dos buckets.
--
-- Idempotente. Rollback:
--   supabase/rollbacks/20260726200000_proteger_storage_documentos_financeiros_down.sql
-- Backfill (opcional, reversível, NÃO aplicado aqui):
--   supabase/rollbacks/20260726200000_backfill_url_para_caminho_interno.sql
-- Escopo estrito: NÃO trata fotos-perfil, envios-financeiro, notas-fiscais,
-- elogios-prints, outros buckets, policies always-true de tabelas nem views
-- SECURITY DEFINER. Não remove objetos órfãos.

------------------------------------------------------------------------------
-- 1) Limites de upload (afeta apenas uploads futuros; objetos atuais intactos).
--    Buckets já são privados (public=false) — reforçado por segurança.
--    MIME conforme o input do front: .pdf,.png,.jpg,.jpeg,.doc,.docx
------------------------------------------------------------------------------
UPDATE storage.buckets
   SET public = false,
       file_size_limit = 20971520, -- 20 MB
       allowed_mime_types = ARRAY[
         'application/pdf',
         'image/png',
         'image/jpeg',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
       ]
 WHERE id IN ('comprovantes-pagamento','termos-acordo');

------------------------------------------------------------------------------
-- 2) Remover as policies AMPLAS anteriores (bucket-wide, sem escopo).
------------------------------------------------------------------------------
DROP POLICY IF EXISTS "ver comprovantes pagamento"       ON storage.objects; -- SELECT amplo
DROP POLICY IF EXISTS "upload comprovantes pagamento"    ON storage.objects; -- INSERT amplo
DROP POLICY IF EXISTS "atualizar comprovantes pagamento" ON storage.objects; -- UPDATE amplo
DROP POLICY IF EXISTS "ver termos acordo"                ON storage.objects; -- SELECT amplo
DROP POLICY IF EXISTS "upload termos acordo"             ON storage.objects; -- INSERT amplo
DROP POLICY IF EXISTS "atualizar termos acordo"          ON storage.objects; -- UPDATE amplo

------------------------------------------------------------------------------
-- 3) SEM policy de INSERT para authenticated. O upload é AUTORIZADO caso a caso
--    pela Edge Function `documento-financeiro-url` (ação "upload"), que valida o
--    vínculo do usuário com o registro e emite um signed upload URL controlado
--    por uma TABELA DE INTENÇÕES (unicidade por tipo+registro+campo) e upsert:false,
--    com caminho de UUID resolvido no servidor. O arquivo trafega direto
--    navegador->Storage sob esse token, sem depender de RLS de INSERT. Assim não
--    resta nenhuma policy genérica de INSERT baseada só em "usuário ativo", e o
--    cliente não escolhe bucket, pasta nem nome. Garantia idempotente de ausência:
DROP POLICY IF EXISTS "docfin_comprovantes_insert_cadastrado" ON storage.objects;
DROP POLICY IF EXISTS "docfin_termos_insert_cadastrado"       ON storage.objects;
DROP POLICY IF EXISTS "upload comprovantes pagamento"         ON storage.objects;
DROP POLICY IF EXISTS "upload termos acordo"                  ON storage.objects;

------------------------------------------------------------------------------
-- 4) UPDATE restrito à gestão (impede substituição por terceiros).
------------------------------------------------------------------------------
DROP POLICY IF EXISTS "docfin_comprovantes_update_gestao" ON storage.objects;
CREATE POLICY "docfin_comprovantes_update_gestao" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'comprovantes-pagamento' AND public.usuario_e_gestao())
  WITH CHECK (bucket_id = 'comprovantes-pagamento' AND public.usuario_e_gestao());

DROP POLICY IF EXISTS "docfin_termos_update_gestao" ON storage.objects;
CREATE POLICY "docfin_termos_update_gestao" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'termos-acordo' AND public.usuario_e_gestao())
  WITH CHECK (bucket_id = 'termos-acordo' AND public.usuario_e_gestao());

------------------------------------------------------------------------------
-- 5) DELETE restrito à gestão (não apaga objeto por operador). Esta migration
--    NÃO executa nenhum DELETE de objeto — apenas define a policy.
------------------------------------------------------------------------------
DROP POLICY IF EXISTS "docfin_comprovantes_delete_gestao" ON storage.objects;
CREATE POLICY "docfin_comprovantes_delete_gestao" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'comprovantes-pagamento' AND public.usuario_e_gestao());

DROP POLICY IF EXISTS "docfin_termos_delete_gestao" ON storage.objects;
CREATE POLICY "docfin_termos_delete_gestao" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'termos-acordo' AND public.usuario_e_gestao());

------------------------------------------------------------------------------
-- 6) CONTROLE DE INTENÇÃO DE UPLOAD.
--    createSignedUploadUrl é válido por ~2h e NÃO é uso único. Para impedir
--    autorizações repetidas e sobrescrita, cada upload passa por uma INTENÇÃO
--    registrada e protegida (só service_role acessa). Unicidade garantida por
--    índice parcial em (tipo_documento, registro_id, campo_documento) enquanto
--    ativa. Não guarda CPF/nome/matrícula/telefone/URL assinada.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.documentos_financeiros_upload_intentos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_documento text        NOT NULL,
  registro_id    uuid        NOT NULL,
  campo_documento text       NOT NULL,
  bucket         text        NOT NULL,
  caminho        text        NOT NULL,
  mime_esperado  text        NOT NULL,
  tamanho_maximo bigint      NOT NULL,
  solicitado_por text        NOT NULL,
  solicitado_em  timestamptz NOT NULL DEFAULT now(),
  expira_em      timestamptz NOT NULL,
  status         text        NOT NULL DEFAULT 'AUTORIZADO'
                   CHECK (status IN ('AUTORIZADO','ENVIADO','VINCULADO','EXPIRADO','CANCELADO')),
  vinculado_em   timestamptz,
  motivo_falha   text
);

-- No máximo UMA intenção ativa por (tipo, registro, campo).
CREATE UNIQUE INDEX IF NOT EXISTS ux_docfin_intento_ativo
  ON public.documentos_financeiros_upload_intentos (tipo_documento, registro_id, campo_documento)
  WHERE status IN ('AUTORIZADO','ENVIADO');
CREATE INDEX IF NOT EXISTS ix_docfin_intento_registro
  ON public.documentos_financeiros_upload_intentos (registro_id, campo_documento);

-- RLS + revogação: anon e authenticated NÃO acessam a tabela de forma alguma.
-- Sem policies => tudo bloqueado; service_role ignora RLS (único a ler/gravar).
ALTER TABLE public.documentos_financeiros_upload_intentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documentos_financeiros_upload_intentos FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.documentos_financeiros_upload_intentos FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public.documentos_financeiros_upload_intentos TO service_role;

------------------------------------------------------------------------------
-- 6.1) RPC: solicitar/reutilizar intenção (lock + unicidade + geração de path).
--      Só service_role executa. Bloqueia registro já vinculado e evita 2ª
--      autorização concorrente para o mesmo tipo+registro+campo.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.docfin_solicitar_intento(
  p_tipo text, p_registro uuid, p_campo text,
  p_tabela text, p_coluna text, p_bucket text,
  p_mime text, p_tam_max bigint, p_ext text, p_ttl_seg int, p_ator text
) RETURNS TABLE(intent_id uuid, bucket text, caminho text, situacao text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_existe public.documentos_financeiros_upload_intentos%ROWTYPE;
  v_linked boolean;
  v_id uuid;
  v_path text;
BEGIN
  -- Lock concorrente pelo alvo (tipo|registro|campo).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tipo || '|' || p_registro::text || '|' || p_campo, 0));

  -- Expira intenções vencidas do mesmo alvo.
  UPDATE public.documentos_financeiros_upload_intentos
     SET status = 'EXPIRADO'
   WHERE tipo_documento = p_tipo AND registro_id = p_registro AND campo_documento = p_campo
     AND status IN ('AUTORIZADO','ENVIADO') AND expira_em < now();

  -- Registro já possui documento vinculado?
  EXECUTE format('SELECT (%I IS NOT NULL) FROM public.%I WHERE id = $1', p_coluna, p_tabela)
    INTO v_linked USING p_registro;
  IF coalesce(v_linked, false) THEN
    RETURN QUERY SELECT NULL::uuid, p_bucket, NULL::text, 'JA_VINCULADO'::text; RETURN;
  END IF;

  -- Já existe intenção ativa? Reutiliza (não gera outro caminho).
  SELECT * INTO v_existe FROM public.documentos_financeiros_upload_intentos
   WHERE tipo_documento = p_tipo AND registro_id = p_registro AND campo_documento = p_campo
     AND status IN ('AUTORIZADO','ENVIADO') AND expira_em >= now()
   ORDER BY solicitado_em DESC LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_existe.id, v_existe.bucket, v_existe.caminho, 'REUSO'::text; RETURN;
  END IF;

  -- Nova intenção: caminho = registro/uuid.ext (sem dado pessoal).
  v_id := gen_random_uuid();
  v_path := p_registro::text || '/' || gen_random_uuid()::text || '.' || p_ext;
  INSERT INTO public.documentos_financeiros_upload_intentos(
    id, tipo_documento, registro_id, campo_documento, bucket, caminho,
    mime_esperado, tamanho_maximo, solicitado_por, expira_em, status)
  VALUES (v_id, p_tipo, p_registro, p_campo, p_bucket, v_path,
    p_mime, p_tam_max, p_ator, now() + make_interval(secs => p_ttl_seg), 'AUTORIZADO');

  RETURN QUERY SELECT v_id, p_bucket, v_path, 'NOVO'::text;
END $$;

------------------------------------------------------------------------------
-- 6.2) RPC: vincular (atômico + idempotente). Só service_role executa.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.docfin_vincular(
  p_intent_id uuid, p_tabela text, p_coluna text, p_ator text, p_gestao boolean
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE it public.documentos_financeiros_upload_intentos%ROWTYPE; n int;
BEGIN
  SELECT * INTO it FROM public.documentos_financeiros_upload_intentos WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NAO_ENCONTRADA'; END IF;
  IF NOT p_gestao AND lower(coalesce(it.solicitado_por,'')) <> lower(p_ator) THEN RETURN 'NAO_AUTORIZADA'; END IF;
  IF it.status = 'VINCULADO' THEN RETURN 'JA_VINCULADO'; END IF;             -- idempotente
  IF it.status NOT IN ('AUTORIZADO','ENVIADO') THEN RETURN 'INVALIDA'; END IF;
  IF it.expira_em < now() THEN
    UPDATE public.documentos_financeiros_upload_intentos SET status='EXPIRADO' WHERE id = p_intent_id;
    RETURN 'EXPIRADA';
  END IF;

  -- Grava o caminho na coluna do registro só se ainda vazio (trava anti-corrida).
  EXECUTE format('UPDATE public.%I SET %I = $1 WHERE id = $2 AND %I IS NULL', p_tabela, p_coluna, p_coluna)
    USING it.caminho, it.registro_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN 'REGISTRO_JA_VINCULADO'; END IF;

  -- Auditoria operacional onde já existe (comprovante de link).
  IF p_tabela = 'links_pagamento' THEN
    UPDATE public.links_pagamento
       SET comprovante_anexado_por = p_ator, comprovante_anexado_em = now()
     WHERE id = it.registro_id;
    INSERT INTO public.historico_links_pagamento(link_pagamento_id, observacao, usuario_email)
      VALUES (it.registro_id, 'Comprovante anexado (upload autorizado por servidor).', p_ator);
  END IF;

  UPDATE public.documentos_financeiros_upload_intentos
     SET status = 'VINCULADO', vinculado_em = now() WHERE id = p_intent_id;
  RETURN 'OK';
END $$;

-- Execução restrita ao service_role (Edge Function). Nunca anon/authenticated.
REVOKE ALL ON FUNCTION public.docfin_solicitar_intento(text,uuid,text,text,text,text,text,bigint,text,int,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.docfin_vincular(uuid,text,text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.docfin_solicitar_intento(text,uuid,text,text,text,text,text,bigint,text,int,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.docfin_vincular(uuid,text,text,text,boolean) TO service_role;

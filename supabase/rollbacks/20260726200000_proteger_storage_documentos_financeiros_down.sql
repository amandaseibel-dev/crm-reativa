-- ROLLBACK — 20260726200000_proteger_storage_documentos_financeiros
-- -----------------------------------------------------------------------------
-- ATENÇÃO: este rollback REABRE o acesso amplo. Ao restaurar as policies
-- originais, QUALQUER usuário autenticado volta a poder VER/ENUMERAR e enviar
-- comprovantes de pagamento e termos de acordo de QUALQUER registro (o exato
-- acesso cruzado que a remediação eliminou). Use apenas em emergência de fluxo.
--
-- Não recria bucket público (os buckets já eram privados antes). Não toca em
-- objetos do Storage. Idempotente.

-- 0) Remover os objetos novos do controle de intenção de upload (funções,
--    índices e tabela). Não havia nada disso no baseline.
DROP FUNCTION IF EXISTS public.docfin_vincular(uuid,text,text,text,boolean);
DROP FUNCTION IF EXISTS public.docfin_solicitar_intento(text,uuid,text,text,text,text,text,bigint,text,int,text);
DROP INDEX  IF EXISTS public.ux_docfin_intento_ativo;
DROP INDEX  IF EXISTS public.ix_docfin_intento_registro;
DROP TABLE  IF EXISTS public.documentos_financeiros_upload_intentos;

-- 1) Remover as policies restritivas introduzidas pela remediação.
DROP POLICY IF EXISTS "docfin_comprovantes_insert_cadastrado" ON storage.objects;
DROP POLICY IF EXISTS "docfin_termos_insert_cadastrado"       ON storage.objects;
DROP POLICY IF EXISTS "docfin_comprovantes_update_gestao"     ON storage.objects;
DROP POLICY IF EXISTS "docfin_termos_update_gestao"           ON storage.objects;
DROP POLICY IF EXISTS "docfin_comprovantes_delete_gestao"     ON storage.objects;
DROP POLICY IF EXISTS "docfin_termos_delete_gestao"           ON storage.objects;

-- 2) Restaurar as policies AMPLAS originais (definições exatas do estado anterior).
DROP POLICY IF EXISTS "ver comprovantes pagamento" ON storage.objects;
CREATE POLICY "ver comprovantes pagamento" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'comprovantes-pagamento');

DROP POLICY IF EXISTS "upload comprovantes pagamento" ON storage.objects;
CREATE POLICY "upload comprovantes pagamento" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'comprovantes-pagamento');

DROP POLICY IF EXISTS "atualizar comprovantes pagamento" ON storage.objects;
CREATE POLICY "atualizar comprovantes pagamento" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'comprovantes-pagamento')
  WITH CHECK (bucket_id = 'comprovantes-pagamento');

DROP POLICY IF EXISTS "ver termos acordo" ON storage.objects;
CREATE POLICY "ver termos acordo" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'termos-acordo');

DROP POLICY IF EXISTS "upload termos acordo" ON storage.objects;
CREATE POLICY "upload termos acordo" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'termos-acordo');

DROP POLICY IF EXISTS "atualizar termos acordo" ON storage.objects;
CREATE POLICY "atualizar termos acordo" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'termos-acordo')
  WITH CHECK (bucket_id = 'termos-acordo');

-- 3) Restaurar a configuração EXATA dos buckets no baseline (capturado em
--    produção, 2026-07-26): public=false, file_size_limit=NULL,
--    allowed_mime_types=NULL para ambos.
UPDATE storage.buckets
   SET public = false,
       file_size_limit = NULL,
       allowed_mime_types = NULL
 WHERE id IN ('comprovantes-pagamento','termos-acordo');

-- 4) Funções/grants: a remediação NÃO alterou nenhuma função nem grant
--    (reusa public.perfil_do_usuario_atual() e public.usuario_e_gestao() como já
--    existiam). Portanto não há definição de função a restaurar aqui.

-- Observação: no baseline NÃO existiam policies de DELETE para estes buckets.
-- O rollback acima remove as policies de DELETE introduzidas (docfin_*), então o
-- estado de DELETE volta ao original (nenhuma policy => nenhum DELETE por
-- authenticated), equivalente ao baseline.

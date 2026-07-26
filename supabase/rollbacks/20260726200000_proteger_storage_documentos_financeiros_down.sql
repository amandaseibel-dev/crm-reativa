-- ROLLBACK — 20260726200000_proteger_storage_documentos_financeiros
-- -----------------------------------------------------------------------------
-- ATENÇÃO: este rollback REABRE o acesso amplo. Ao restaurar as policies
-- originais, QUALQUER usuário autenticado volta a poder VER/ENUMERAR e enviar
-- comprovantes de pagamento e termos de acordo de QUALQUER registro (o exato
-- acesso cruzado que a remediação eliminou). Use apenas em emergência de fluxo.
--
-- Não recria bucket público (os buckets já eram privados antes). Não toca em
-- objetos do Storage. Idempotente.

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

-- 3) (Opcional) Reverter limites do bucket ao estado original (sem limite/MIME).
--    Descomente se necessário — não afeta segurança de acesso.
-- UPDATE storage.buckets
--    SET file_size_limit = NULL, allowed_mime_types = NULL
--  WHERE id IN ('comprovantes-pagamento','termos-acordo');

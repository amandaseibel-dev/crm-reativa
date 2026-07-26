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
--   3) INSERT por menor privilégio: só usuário CADASTRADO e ATIVO, no bucket
--      certo (bloqueia anon e não-cadastrado);
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
-- 3) INSERT (por bucket): somente cadastrado+ativo. SEM SELECT para authenticated.
------------------------------------------------------------------------------
DROP POLICY IF EXISTS "docfin_comprovantes_insert_cadastrado" ON storage.objects;
CREATE POLICY "docfin_comprovantes_insert_cadastrado" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'comprovantes-pagamento'
    AND public.perfil_do_usuario_atual() IS NOT NULL
  );

DROP POLICY IF EXISTS "docfin_termos_insert_cadastrado" ON storage.objects;
CREATE POLICY "docfin_termos_insert_cadastrado" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'termos-acordo'
    AND public.perfil_do_usuario_atual() IS NOT NULL
  );

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

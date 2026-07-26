-- ============================================================================
-- ROLLBACK de 20260726190000_proteger_storage_fotos_perfil.sql
-- ============================================================================
--
-- !!! AVISO DE SEGURANÇA / LGPD — LEIA ANTES DE EXECUTAR !!!
-- Este script REABRE O ACESSO PÚBLICO ao bucket `fotos-perfil`: torna o bucket
-- público novamente, restaura as policies AMPLAS (authenticated vê/envia/atualiza
-- QUALQUER objeto) e reconstrói as URLs públicas permanentes. Com isso, o anon
-- volta a LER e ENUMERAR as fotos de perfil (reintroduz o alerta
-- public_bucket_allows_listing). Use apenas em EMERGÊNCIA e com AUTORIZAÇÃO
-- EXPRESSA da gestão de segurança. NÃO exclui nenhum objeto do Storage.
--
-- Restaura exatamente o estado anterior: bucket público sem limites, as 3
-- policies originais e o usuarios.foto_url (URL pública reconstruída a partir do
-- caminho interno), removendo a coluna foto_path.

------------------------------------------------------------------------------
-- 1) Reconstruir usuarios.foto_url (URL pública) a partir de foto_path e
--    remover a coluna foto_path. Só reconstrói onde havia caminho convertido.
--    Projeto de produção: ahattpqrjmhkzsmnbdzs.
------------------------------------------------------------------------------
UPDATE public.usuarios
   SET foto_url = 'https://ahattpqrjmhkzsmnbdzs.supabase.co/storage/v1/object/public/fotos-perfil/' || foto_path
 WHERE foto_path IS NOT NULL AND foto_path <> ''
   AND (foto_url IS NULL OR foto_url = '');

ALTER TABLE public.usuarios DROP COLUMN IF EXISTS foto_path;

------------------------------------------------------------------------------
-- 2) Remover as policies de menor privilégio criadas pela migration.
------------------------------------------------------------------------------
DROP POLICY IF EXISTS "fotos_perfil_insert_propria_ou_gestao" ON storage.objects;
DROP POLICY IF EXISTS "fotos_perfil_update_propria_ou_gestao" ON storage.objects;
DROP POLICY IF EXISTS "fotos_perfil_delete_propria_ou_gestao" ON storage.objects;

------------------------------------------------------------------------------
-- 3) Restaurar as 3 policies AMPLAS originais (estado vulnerável).
------------------------------------------------------------------------------
DROP POLICY IF EXISTS "ver fotos perfil" ON storage.objects;
CREATE POLICY "ver fotos perfil" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'fotos-perfil');

DROP POLICY IF EXISTS "upload fotos perfil" ON storage.objects;
CREATE POLICY "upload fotos perfil" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'fotos-perfil');

DROP POLICY IF EXISTS "atualizar fotos perfil" ON storage.objects;
CREATE POLICY "atualizar fotos perfil" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'fotos-perfil')
  WITH CHECK (bucket_id = 'fotos-perfil');

------------------------------------------------------------------------------
-- 4) Tornar o bucket público novamente e remover limites (estado anterior).
------------------------------------------------------------------------------
UPDATE storage.buckets
   SET public = true,
       file_size_limit = NULL,
       allowed_mime_types = NULL
 WHERE id = 'fotos-perfil';

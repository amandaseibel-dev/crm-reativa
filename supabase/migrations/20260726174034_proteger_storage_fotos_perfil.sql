-- Remediação de segurança (LGPD): proteger o bucket `fotos-perfil`.
-- -----------------------------------------------------------------------------
-- Antes: bucket PÚBLICO (public=true), sem limite de tamanho/MIME, com policies
-- AMPLAS (authenticated podia ver/enviar/atualizar QUALQUER objeto) e URLs
-- públicas permanentes persistidas em usuarios.foto_url. Anon lia e ENUMERAVA.
--
-- Depois:
--   1) bucket PRIVADO, com limite de 2MB e MIME restrito a imagens;
--   2) removidas as 3 policies amplas de fotos-perfil;
--   3) SEM policy SELECT para authenticated => cliente não lê nem lista (zero
--      enumeração, nem por logado); leitura só via Edge Function `foto-perfil-url`
--      (service role no servidor), que assina URLs de curta duração;
--   4) escrita (INSERT/UPDATE/DELETE) por menor privilégio: só o DONO
--      (pasta = auth.uid()) OU gestão autorizada, e sempre usuário ATIVO;
--   5) passa a persistir apenas o CAMINHO INTERNO (usuarios.foto_path), sem URL
--      pública permanente.
--
-- Reusa controles centrais existentes: public.perfil_do_usuario_atual()
-- (cadastrado+ativo) e public.usuario_e_gestao(). postgres e service_role
-- preservados (service_role ignora RLS). NÃO exclui nenhum objeto do Storage.
--
-- Idempotente. Rollback: supabase/rollbacks/20260726190000_proteger_storage_fotos_perfil_down.sql
-- Escopo estrito: NÃO trata comprovantes-pagamento, termos-acordo, outros
-- buckets, policies always-true de tabelas nem views SECURITY DEFINER.

------------------------------------------------------------------------------
-- 1) Bucket privado + limites (afeta apenas uploads futuros; objetos atuais
--    permanecem intactos).
------------------------------------------------------------------------------
UPDATE storage.buckets
   SET public = false,
       file_size_limit = 2097152, -- 2 MB (alinhado ao limite já usado no front)
       allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp']
 WHERE id = 'fotos-perfil';

------------------------------------------------------------------------------
-- 2) Remover as policies AMPLAS anteriores (bucket-wide, sem escopo).
------------------------------------------------------------------------------
DROP POLICY IF EXISTS "ver fotos perfil"       ON storage.objects;
DROP POLICY IF EXISTS "upload fotos perfil"    ON storage.objects;
DROP POLICY IF EXISTS "atualizar fotos perfil" ON storage.objects;

------------------------------------------------------------------------------
-- 3) Policies específicas por operação, menor privilégio. SEM SELECT para
--    authenticated (leitura só pela Edge Function via service role).
------------------------------------------------------------------------------
DROP POLICY IF EXISTS "fotos_perfil_insert_propria_ou_gestao" ON storage.objects;
CREATE POLICY "fotos_perfil_insert_propria_ou_gestao" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'fotos-perfil'
    AND public.perfil_do_usuario_atual() IS NOT NULL
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.usuario_e_gestao()
    )
  );

DROP POLICY IF EXISTS "fotos_perfil_update_propria_ou_gestao" ON storage.objects;
CREATE POLICY "fotos_perfil_update_propria_ou_gestao" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'fotos-perfil'
    AND public.perfil_do_usuario_atual() IS NOT NULL
    AND ((storage.foldername(name))[1] = auth.uid()::text OR public.usuario_e_gestao())
  )
  WITH CHECK (
    bucket_id = 'fotos-perfil'
    AND public.perfil_do_usuario_atual() IS NOT NULL
    AND ((storage.foldername(name))[1] = auth.uid()::text OR public.usuario_e_gestao())
  );

DROP POLICY IF EXISTS "fotos_perfil_delete_propria_ou_gestao" ON storage.objects;
CREATE POLICY "fotos_perfil_delete_propria_ou_gestao" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'fotos-perfil'
    AND public.perfil_do_usuario_atual() IS NOT NULL
    AND ((storage.foldername(name))[1] = auth.uid()::text OR public.usuario_e_gestao())
  );

------------------------------------------------------------------------------
-- 4) Passar a persistir o CAMINHO INTERNO em usuarios.foto_path e aposentar a
--    URL pública. Backfill INEQUÍVOCO: só converte quando foto_url é uma URL
--    pública do bucket fotos-perfil. Registros ambíguos (outras URLs, base64,
--    NULL) ficam para revisão: foto_path permanece NULL e foto_url intacto.
--    Nenhuma foto é perdida (o objeto no Storage não é tocado).
------------------------------------------------------------------------------
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS foto_path text;

UPDATE public.usuarios
   SET foto_path = regexp_replace(
                     regexp_replace(foto_url, '\?.*$', ''),      -- remove querystring
                     '^.*/object/public/fotos-perfil/', ''       -- mantém só o caminho interno
                   ),
       foto_url  = NULL
 WHERE foto_url LIKE '%/object/public/fotos-perfil/%'
   AND (foto_path IS NULL OR foto_path = '');

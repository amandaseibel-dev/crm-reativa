-- ============================================================================
-- Bloco 6 — Storage: bucket envios-financeiro (privado) deixa de ter SELECT global.
-- Anexos são gravados sob pasta = aluno_id. Operador só acessa anexos de alunos
-- sob sua responsabilidade; gestão acessa todos. Upload (INSERT) e signed URLs
-- inalterados. anon permanece bloqueado (todas as policies são {authenticated}).
-- ============================================================================
drop policy if exists envios_financeiro_select on storage.objects;
create policy envios_financeiro_select on storage.objects for select to authenticated
using (
  bucket_id = 'envios-financeiro' and (
    public.usuario_e_gestao()
    or exists (
      select 1 from public.alunos a
      where a.id::text = (storage.foldername(name))[1]
        and lower(coalesce(a.responsavel_atual_email,'')) = lower(auth.email())
    )
  )
);

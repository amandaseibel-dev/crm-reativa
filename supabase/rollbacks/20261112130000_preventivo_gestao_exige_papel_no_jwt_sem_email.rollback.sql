-- Devolve o corpo VIVO anterior (com Angela e Gustavo, 20261008180000). Reintroduz a falha do JWT sem e-mail.
create or replace function public.preventivo_e_gestao()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare em text := lower(coalesce((auth.jwt() ->> 'email'), ''));
begin
  if em = '' then
    return current_user in ('postgres', 'supabase_admin', 'service_role');
  end if;
  return em in (
           'amanda.seibel@aelbra.com.br',
           'angela.ferreira@aelbra.com.br',
           'gustavo.ene@aelbra.com.br'
         )
     and exists (select 1 from public.usuarios u where lower(u.email) = em and u.ativo is true);
end;
$$;

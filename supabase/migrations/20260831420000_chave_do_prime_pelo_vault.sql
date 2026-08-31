-- A chave do Prime sai do Vault, so para o service_role.
--
-- O secret PRIME_API_KEY nao chega nas Edge Functions novas -- medido: a
-- primeira versao de `prime-acordo` respondeu "PRIME_API_KEY ausente". A chave
-- existe no Vault como `prime_api_key`, e e por la que a funcao busca.
--
-- Ela da acesso a CPF e financeiro de 400 mil pessoas: nunca no navegador,
-- nunca no repositorio, nunca em log.

create or replace function public.prime_chave_api()
returns text
language plpgsql security definer
set search_path to 'public'
as $function$
declare v text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Acesso negado.' using errcode='42501';
  end if;
  select decrypted_secret into v from vault.decrypted_secrets where name='prime_api_key';
  return v;
end;
$function$;
revoke all on function public.prime_chave_api() from public, anon, authenticated;
grant execute on function public.prime_chave_api() to service_role;

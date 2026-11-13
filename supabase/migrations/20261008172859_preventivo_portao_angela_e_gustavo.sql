-- PREVENTIVO: o portao passa a aceitar Angela e Gustavo (diretoria).
-- Allowlist por e-mail, nao mudanca de perfil: os dois seguem `diretoria`.
-- Portao exclusivo do modulo (11 tabelas prev_ + RPCs); usuario_e_gestao() e
-- afins NAO sao tocadas. O `ativo` de public.usuarios continua valendo.
-- Reversao: supabase/rollbacks/20261008180000_preventivo_portao_angela_e_gustavo.rollback.sql

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
    -- sem usuário final: só chamada interna de sistema (Edge Function com
    -- service_role, cron). Nunca `anon`.
    return current_user in ('postgres', 'supabase_admin', 'service_role');
  end if;
  return em in (
           'amanda.seibel@aelbra.com.br',
           'angela.ferreira@aelbra.com.br', -- Angela (diretoria), 08/10/2026
           'gustavo.ene@aelbra.com.br'      -- Gustavo (diretoria), 08/10/2026
         )
     and exists (select 1 from public.usuarios u where lower(u.email) = em and u.ativo is true);
end;
$$;

comment on function public.preventivo_e_gestao() is
  'Preventivo: verdadeiro para a Amanda da gestão (amanda.seibel@aelbra.com.br) e para a diretoria liberada em 08/10/2026 (angela.ferreira@aelbra.com.br, gustavo.ene@aelbra.com.br), em todos os casos somente se o cadastro estiver ativo em public.usuarios; ou para chamada interna de sistema. Amanda ADM e demais perfis NÃO passam. Portão exclusivo do módulo Preventivo (11 tabelas prev_ + RPCs do módulo): não concede gestão em nenhuma outra tela. Espelho no frontend: EMAILS_PREVENTIVO em src/App.jsx.';

revoke all on function public.preventivo_e_gestao() from public;
grant execute on function public.preventivo_e_gestao() to authenticated, service_role;

do $trava$
declare
  v_em text;
  v_ok boolean;
begin
  foreach v_em in array array[
    'amanda.seibel@aelbra.com.br','angela.ferreira@aelbra.com.br','gustavo.ene@aelbra.com.br'
  ] loop
    if not exists (select 1 from public.usuarios u where lower(u.email) = v_em and u.ativo is true) then
      raise exception 'TRAVA: % nao esta ativo em public.usuarios', v_em;
    end if;
    perform set_config('request.jwt.claims', json_build_object('role','authenticated','email',v_em)::text, true);
    if not public.preventivo_e_gestao() then
      raise exception 'TRAVA: % deveria passar no portao do Preventivo', v_em;
    end if;
  end loop;

  foreach v_em in array array[
    'cobranca07@aelbra.com.br','cobranca04@aelbra.com.br','cobranca01@aelbra.com.br'
  ] loop
    perform set_config('request.jwt.claims', json_build_object('role','authenticated','email',v_em)::text, true);
    if public.preventivo_e_gestao() then
      raise exception 'TRAVA: % NAO deveria passar no portao do Preventivo', v_em;
    end if;
  end loop;

  perform set_config('request.jwt.claims', '{"role":"authenticated","email":"ninguem@exemplo.com"}', true);
  if public.preventivo_e_gestao() then
    raise exception 'TRAVA: e-mail sem cadastro passou no portao';
  end if;

  perform set_config('request.jwt.claims', '', true);
  select public.preventivo_e_gestao() into v_ok;
  if v_ok is null then raise exception 'TRAVA: portao retornou nulo sem JWT'; end if;

  if has_function_privilege('anon', 'public.preventivo_e_gestao()', 'execute') then
    raise exception 'TRAVA: anon ficou com execute no portao do Preventivo';
  end if;
  if not has_function_privilege('authenticated', 'public.preventivo_e_gestao()', 'execute') then
    raise exception 'TRAVA: authenticated perdeu execute';
  end if;
end;
$trava$;
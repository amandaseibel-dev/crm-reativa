-- ============================================================================
-- ROLLBACK de 20261008180000 -- devolve o Preventivo a UM e-mail só.
-- ============================================================================
-- Reescreve `preventivo_e_gestao()` no texto exato de 28/09
-- (20260928143743_preventivo_estrutura.sql). Reescrita inteira é segura AQUI,
-- e só aqui, porque nenhuma migration posterior tocou esta função -- ela nasceu
-- em 28/09 e a de 08/10 foi a primeira a mudá-la. (Em função que recebeu patches
-- de vários dias isto apagaria os outros em silêncio; não é o caso.)
--
-- Depois disto Angela e Gustavo deixam de alcançar o módulo: o menu esconde o
-- item, a rota redireciona e a RLS das 11 tabelas `prev_` recusa. Nenhuma linha
-- de dado é tocada -- o que eles tiverem gravado em remessa, ação ou custo
-- CONTINUA no banco; o rollback fecha a porta, não desfaz o que passou por ela.
--
-- Ao reverter, tirar também `angela.ferreira@aelbra.com.br` e
-- `gustavo.ene@aelbra.com.br` de `EMAILS_PREVENTIVO` e `/preventivo` de
-- `DIRETORIA_ROTAS`, em src/App.jsx. Frontend aberto com banco fechado = tela
-- que abre e volta vazia, que é pior do que não abrir.
-- ============================================================================

begin;

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
  return em = 'amanda.seibel@aelbra.com.br'
     and exists (select 1 from public.usuarios u where lower(u.email) = em and u.ativo is true);
end;
$$;

comment on function public.preventivo_e_gestao() is
  'Preventivo: verdadeiro somente para a Amanda da gestão (amanda.seibel@aelbra.com.br, perfil gerencia, ativa) ou para chamada interna de sistema. Amanda ADM e demais perfis NÃO passam.';

revoke all on function public.preventivo_e_gestao() from public;
grant execute on function public.preventivo_e_gestao() to authenticated, service_role;

do $trava$
declare v_em text;
begin
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","email":"amanda.seibel@aelbra.com.br"}', true);
  if not public.preventivo_e_gestao() then
    raise exception 'TRAVA: rollback derrubou a própria tela da gestão';
  end if;

  foreach v_em in array array['angela.ferreira@aelbra.com.br','gustavo.ene@aelbra.com.br'] loop
    perform set_config('request.jwt.claims',
      json_build_object('role','authenticated','email',v_em)::text, true);
    if public.preventivo_e_gestao() then
      raise exception 'TRAVA: % continua passando após o rollback', v_em;
    end if;
  end loop;

  if has_function_privilege('anon', 'public.preventivo_e_gestao()', 'execute') then
    raise exception 'TRAVA: anon ficou com execute no portão do Preventivo';
  end if;

  raise notice 'OK: portão do Preventivo de volta a um e-mail só.';
end;
$trava$;

commit;

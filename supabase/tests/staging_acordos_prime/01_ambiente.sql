-- AMBIENTE ISOLADO para validar a seção de RLS/grants da
-- PROPOSTA_staging_acordos_prime.sql.
--
-- Roda num Postgres descartavel do CI. NAO fala com producao, NAO usa segredo.
--
-- O QUE ESTE ARQUIVO RECRIA, e por que cada parte importa:
--
--   1. OS PAPEIS do Supabase (anon, authenticated, service_role). Sem eles os
--      revoke/grant da proposta nao teriam em quem pegar.
--
--   2. O ALTER DEFAULT PRIVILEGES. Esta e a parte que mais engana, e a razao de
--      este teste existir: em producao, tabela criada por postgres em `public`
--      NASCE com privilegio para authenticated -- INCLUSIVE TRUNCATE, que a RLS
--      nao cobre. Sem reproduzir isso aqui, a tabela nasceria fechada por
--      acidente e o teste diria "tudo certo" sem ter exercitado a armadilha.
--
--   3. O STUB de usuario_e_gestao(), que e o portao das policies, e de auth.jwt()
--      /auth.role(), que ele usaria em producao. Num banco vazio nao existem.
--
-- NAO cria pgcrypto: `gen_random_uuid()` e nativo do Postgres desde a 13, que
-- e o piso tanto do Supabase quanto do PGlite. Pedir a extensao quebraria o
-- runner em PGlite, que nao a tem, sem acrescentar nada.

\set ON_ERROR_STOP on

-- 1. Os tres papeis do Supabase.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  -- BYPASSRLS reproduz o comportamento do service_role no Supabase: ele
  -- escreve porque contorna RLS por desenho, nao porque tem policy.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- 2. A ARMADILHA, reproduzida: em producao o objeto nasce aberto para
--    authenticated. E isto que faz o revoke da proposta ter trabalho real.
alter default privileges in schema public
  grant all on tables to authenticated;

-- 3. O portao. Em producao `usuario_e_gestao()` e SECURITY DEFINER com
--    search_path fixo e le o JWT; aqui o stub le uma GUC para o teste poder
--    trocar de perfil sem inventar JWT.
create schema if not exists auth;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$$;

create or replace function auth.email() returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.email', true), '')
$$;

create or replace function public.usuario_e_gestao() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_setting('teste.e_gestao', true), 'false')::boolean
$$;

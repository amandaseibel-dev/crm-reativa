-- AMBIENTE ISOLADO — PDF da Projeção Hora a Hora (acesso da tela).
-- Postgres 17 descartável do CI. NÃO fala com produção, NÃO usa segredo.
-- Dados 100% sintéticos (domínio .teste.local). Nenhum e-mail real de produção.
--
-- LIMITE HONESTO: auth.* aqui reproduz o contrato do Supabase (lê
-- request.jwt.claims). As funções de perfil são CÓPIA das definições de produção
-- lidas de pg_get_functiondef em 12/11/2026 (ver docs da #920).

\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon')          then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role')  then create role service_role; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
create extension if not exists unaccent with schema public;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;
create or replace function auth.email() returns text language sql stable as $$
  select auth.jwt() ->> 'email';
$$;
create or replace function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role';
$$;

create table public.usuarios (
  id uuid primary key default gen_random_uuid(),
  email text not null unique, perfil text, ativo boolean not null default true
);
create table public.alunos (id uuid primary key default gen_random_uuid(), unidade text);
create table public.pagamentos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid references public.alunos(id),
  data_pagamento date not null,
  operador_email text, operador_nome text,
  valor_pago numeric not null default 0, valor_honorario numeric not null default 0,
  retroativo boolean not null default false
);

-- Cópias das definições de produção (pg_get_functiondef, 12/11/2026).
create or replace function public.perfil_do_usuario_atual() returns text
language sql stable security definer set search_path to 'public', 'auth' as $$
  select u.perfil from public.usuarios u
  where lower(u.email) = lower(auth.email()) and u.ativo limit 1;
$$;
create or replace function public.usuario_e_diretoria() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.usuarios u
    where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and u.ativo is true and u.perfil = 'diretoria');
$$;

grant execute on function public.perfil_do_usuario_atual(), public.usuario_e_diretoria() to anon, authenticated, service_role;

-- AMBIENTE ISOLADO da leitura do vinculo (Postgres descartavel, nunca producao).
-- As funcoes app_email, eh_painel e a montagem de papeis espelham as definicoes
-- medidas em producao (pg_get_functiondef, 08/11/2026).
\set ON_ERROR_STOP on
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select jsonb_build_object('email', coalesce(current_setting('teste.email', true), ''));
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('teste.uid', true), '')::uuid;
$$;
create table public.usuarios (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  ativo boolean not null default true,
  perfil text not null default 'operador'
);
create table public.alunos (
  id uuid primary key default gen_random_uuid(),
  nome text,
  responsavel_atual_email text
);
create table public.ulbra_vinculos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid references public.alunos (id),
  ulbra_cliente_id text not null,
  confianca text not null,
  desvinculado_em timestamptz
);
create or replace function public.app_email() returns text
language sql stable set search_path = public as $$
  select lower(coalesce((auth.jwt() ->> 'email'), ''));
$$;
create or replace function public.eh_painel() returns boolean
language sql stable security definer set search_path = public as $$
  SELECT coalesce(
    (SELECT lower(u.email) = 'painel.tv@reativa.local'
       FROM public.usuarios u
      WHERE u.id = auth.uid()),
    false);
$$;
create or replace function public.afirmar(condicao boolean, descricao text) returns void
language plpgsql as $$
begin
  if not coalesce(condicao, false) then raise exception 'FALHOU: %', descricao; end if;
  raise notice 'ok: %', descricao;
end;
$$;
-- usuarios: gestao, dois operadores, inativo, painel e supervisor
insert into public.usuarios (id, email, ativo, perfil) values
  ('00000000-0000-0000-0000-0000000000a1', 'op1@x', true, 'operador'),
  ('00000000-0000-0000-0000-0000000000a2', 'op2@x', true, 'operador'),
  ('00000000-0000-0000-0000-0000000000a3', 'amanda.seibel@aelbra.com.br', true, 'gerencia'),
  ('00000000-0000-0000-0000-0000000000a4', 'inativo@x', false, 'operador'),
  ('00000000-0000-0000-0000-0000000000a5', 'painel.tv@reativa.local', true, 'painel'),
  ('00000000-0000-0000-0000-0000000000a6', 'sup@x', true, 'supervisor');

-- Ambiente mínimo para exercitar o piloto em Postgres DE VERDADE.
-- Existe porque o PGlite tem UMA conexão: `for update` e `skip locked` só se
-- provam com duas sessões concorrentes de verdade.
create extension if not exists pgcrypto;

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;

create schema if not exists auth;
create or replace function auth.role() returns text language sql stable
  as $$ select coalesce(current_setting('teste.role', true), 'service_role') $$;
create or replace function public.usuario_e_gestao() returns boolean language sql stable
  as $$ select coalesce(current_setting('teste.gestao', true) <> 'off', true) $$;

create table if not exists public.alunos (id uuid primary key, cpf text);
create table if not exists public.prime_academico_consulta (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid not null references public.alunos(id) on delete cascade,
  cpf text, resultado text, consultado_em timestamptz not null default now(),
  requisicoes integer, http_status integer);

-- o universo não é exercitado aqui
create or replace function public.carteira_academico_universo(p_ano text, p_semestre text default null)
  returns table (aluno_id uuid, cpf text) language sql stable
  as $$ select null::uuid, null::text where false $$;
create or replace function public.carteira_academico_grupo(p_aluno_id uuid) returns text
  language sql stable as $$ select 'Ainda não consultados'::text $$;

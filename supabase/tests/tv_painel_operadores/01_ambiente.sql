-- AMBIENTE ISOLADO — tv_painel_operadores (20261110200000).
-- Postgres descartável do CI. NÃO fala com produção, NÃO usa segredo.
-- Reproduz de propósito o default privileges do projeto (função nova nasce com
-- EXECUTE para anon), para o revoke da migration ser exercitado de verdade.
\set ON_ERROR_STOP on
set timezone = 'UTC';  -- como produção: o "hoje" tem de vir do fuso de Brasília

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon;          end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role;  end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
create or replace function auth.email() returns text language sql stable as $$
  select nullif(current_setting('teste.email', true), '');
$$;

-- Tabelas mínimas, com as colunas que a função lê (nomes e tipos de produção).
create table public.usuarios (id uuid primary key default gen_random_uuid(), email text, nome text);
create table public.pagamentos (id uuid primary key default gen_random_uuid(), data_pagamento date,
  valor_pago numeric, valor_honorario numeric, retroativo boolean default false, operador_email text);
create table public.acordos (id uuid primary key default gen_random_uuid(), criado_em timestamptz,
  duplicado_de uuid, status text, operador_responsavel_email text);
create table public.metas_projecao (id uuid primary key default gen_random_uuid(), mes_referencia text, meta_honorario numeric);
create table public.feriados (data date, nome text, considerar boolean);
create table public.tv_equipe_oculta (email text, nome text);

-- CÓPIAS DAS DEFINIÇÕES DE PRODUÇÃO (pg_get_functiondef em ahattpqrjmhkzsmnbdzs, 10/11/2026).
create or replace function public.dias_uteis(p_ini date, p_fim date) returns integer
language sql stable security definer set search_path to 'public' as $function$
  select count(*)::int
  from generate_series(p_ini, p_fim, interval '1 day') d
  where extract(isodow from d) < 6
    and not exists (select 1 from public.feriados f where f.data = d::date and f.considerar);
$function$;

create or replace function public.tv_pode_ler_snapshot() returns boolean
language sql stable security definer set search_path to 'public' as $function$
  select lower(coalesce(auth.email(),'')) in (
    'painel.tv@reativa.local','amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br'
  );
$function$;

create or replace function public.afirmar(condicao boolean, descricao text) returns void
language plpgsql as $$
begin
  if not coalesce(condicao, false) then raise exception 'FALHOU: %', descricao; end if;
  raise notice 'ok: %', descricao;
end;
$$;
grant execute on function public.afirmar(boolean, text) to authenticated, anon;

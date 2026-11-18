-- Ambiente do CI (PostgreSQL 16 descartável). Papeis reais; auth e tabelas são dublês
-- de estrutura. As DEPENDENCIAS REAIS (corpos) vêm de fixtures/carteira_prioridade/.
create extension if not exists unaccent;
create schema if not exists auth;
create or replace function auth.email() returns text language sql stable as $$
  select nullif(lower(coalesce(coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::json->>'email', '')), '')
$$;
create or replace function auth.jwt() returns json language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::json
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists usuarios (email text primary key, ativo boolean not null);
create table if not exists importacoes (id uuid primary key default gen_random_uuid(), tipo text, created_at timestamp);
create table if not exists aluno_movimentacoes (id bigserial primary key, aluno_id text, tipo text,
  registrado_em timestamptz, lote_id uuid);
create table if not exists whatsapp_conversas (id uuid primary key default gen_random_uuid(), aluno_id uuid);
create table if not exists whatsapp_mensagens (id uuid primary key default gen_random_uuid(), conversa_id uuid,
  direcao text, status text, timestamp_wa timestamptz, criado_em timestamptz);
create table if not exists acoes_massivas_lotes (id uuid primary key default gen_random_uuid(), aluno_ids text[],
  confirmado_em timestamptz, descartado_em timestamptz);

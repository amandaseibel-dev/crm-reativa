-- Ambiente de SIMULAÇÃO das dependências do Supabase, para o teste de acesso do
-- registro do termo físico. Roda num Postgres DESCARTÁVEL do CI.
--
-- O QUE É SIMULADO (não é o Supabase real):
--   * papéis anon, authenticated, service_role (sem BYPASSRLS para anon/authenticated);
--   * privilégios padrão do schema public (tabela e função novas nascem com grant
--     para os três papéis, como no Supabase);
--   * auth.jwt(), lendo request.jwt.claims (o Supabase real usa o mesmo nome);
--   * usuarios / app_usuario_ativo();
--   * usuario_e_gestao(), com o MESMO corpo lido em produção por SELECT em
--     pg_get_functiondef (três e-mails, SECURITY DEFINER, search_path = public);
--   * notificacoes, com a RLS de SELECT por destinatário e a de INSERT só para gestão.
--
-- O QUE NÃO É SIMULADO: outros triggers da produção, grants reais de produção,
-- extensões e a configuração do projeto. Por isso o teste é necessário, mas não
-- suficiente: a conferência das dependências reais é feita por leitura (ver docs).

create schema if not exists auth;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- Privilégios padrão do Supabase: objetos novos em public nascem com acesso amplo.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- Aluno de teste (id uuid, como em produção).
create table public.alunos (id uuid primary key);
insert into public.alunos (id) values ('a0000000-0000-0000-0000-000000000042');

create table public.usuarios (email text primary key, ativo boolean not null default true);
insert into public.usuarios (email) values
  ('amanda.seibel@aelbra.com.br'),
  ('cobranca04@aelbra.com.br'),
  ('cobranca07@aelbra.com.br'),
  ('operador.teste@exemplo.local');
grant select on public.usuarios to authenticated;

create or replace function public.app_usuario_ativo() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.usuarios u
     where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
       and u.ativo)
$$;

-- Corpo lido em produção (pg_get_functiondef, só SELECT). Não é versionado no repo.
create or replace function public.usuario_e_gestao() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
$$;

create table public.notificacoes (
  id                    uuid primary key default gen_random_uuid(),
  usuario_destino_email text not null,
  usuario_destino_nome  text,
  tipo                  text not null,
  titulo                text not null,
  mensagem              text,
  aluno_id              text,
  caso_id uuid, baixa_id uuid, link_pagamento_id uuid, solicitacao_link_id uuid,
  url_destino           text,
  lida                  boolean not null default false,
  lida_em               timestamptz,
  criado_em             timestamptz not null default now()
);
alter table public.notificacoes enable row level security;
create policy notif_select_proprias on public.notificacoes for select to authenticated
  using (lower(usuario_destino_email) = lower(auth.jwt() ->> 'email'));
create policy notificacoes_insert on public.notificacoes for insert to authenticated
  with check (public.app_usuario_ativo() and public.usuario_e_gestao());
grant select, insert, update on public.notificacoes to authenticated;

-- Executa uma CONSULTA como um papel, com um e-mail de JWT. Devolve jsonb:
--   {"ok": true, "rows": [...]} ou {"ok": false, "code": "...", "err": "..."}.
-- Papel NULL = sessão do dono (postgres), sem trocar de papel.
create or replace function public.teste_consulta(p_papel text, p_email text, p_sql text)
returns jsonb language plpgsql as $$
declare
  v_rows jsonb;
begin
  perform set_config('request.jwt.claims',
    case when coalesce(p_email, '') = '' then '{}'
         else json_build_object('email', p_email, 'role', coalesce(p_papel, 'postgres'))::text end,
    false);
  if p_papel is not null then execute format('set role %I', p_papel); end if;
  begin
    execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', p_sql) into v_rows;
  exception when others then
    if p_papel is not null then execute 'reset role'; end if;
    return jsonb_build_object('ok', false, 'code', sqlstate, 'err', sqlerrm);
  end;
  if p_papel is not null then execute 'reset role'; end if;
  return jsonb_build_object('ok', true, 'rows', v_rows);
end $$;

-- Executa um COMANDO (INSERT, UPDATE, DELETE, TRUNCATE, SELECT de função) como um papel.
create or replace function public.teste_comando(p_papel text, p_email text, p_sql text)
returns jsonb language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when coalesce(p_email, '') = '' then '{}'
         else json_build_object('email', p_email, 'role', coalesce(p_papel, 'postgres'))::text end,
    false);
  if p_papel is not null then execute format('set role %I', p_papel); end if;
  begin
    execute p_sql;
  exception when others then
    if p_papel is not null then execute 'reset role'; end if;
    return jsonb_build_object('ok', false, 'code', sqlstate, 'err', sqlerrm);
  end;
  if p_papel is not null then execute 'reset role'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Asserção: falha o script (ON_ERROR_STOP) se a condição não for verdadeira.
create or replace function public.teste_assert(p_nome text, p_cond boolean) returns void
language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FALHOU: %', p_nome;
  end if;
  raise notice 'PASS: %', p_nome;
end $$;

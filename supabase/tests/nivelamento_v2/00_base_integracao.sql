-- BASE VAZIA PARA A INTEGRACAO COM DEFINICOES EXPORTADAS (postgres isolado).
-- Papeis, schema auth (stub do Supabase) e as tabelas que a migration V2 usa mas
-- que nao sao dependencias de funcao (portanto nao vem no export).
-- As tabelas e funcoes de dependencia vem do export (importar_prod_defs.mjs).
\set ON_ERROR_STOP on
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon;          end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role;  end if;
  if not exists (select 1 from pg_roles where rolname = 'reativa_responsavel_executor') then
    create role reativa_responsavel_executor nologin bypassrls;
  end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $f$
  select case when coalesce(current_setting('teste.email', true), '') = '' then null
              else jsonb_build_object('email', current_setting('teste.email', true)) end; $f$;
create or replace function auth.role() returns text language sql stable as $f$ select 'authenticated'::text; $f$;
create schema if not exists cron;
create table if not exists cron.job(jobid bigserial primary key, jobname text unique,
  schedule text not null, command text not null, active boolean not null default true);
create or replace function cron.schedule(p_name text, p_sched text, p_cmd text) returns bigint
language plpgsql as $f$ declare v bigint; begin
  insert into cron.job(jobname, schedule, command) values (p_name, p_sched, p_cmd)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid into v; return v; end $f$;
create or replace function cron.unschedule(p_id bigint) returns boolean language sql as $f$
  with d as (delete from cron.job where jobid = p_id returning 1) select exists(select 1 from d); $f$;
-- tabelas usadas pela migration V2 e pelos testes, fora do fechamento de funcoes
create table if not exists public.baixas_pagamento (
  id uuid primary key default gen_random_uuid(), aluno_id text, aluno_cpf text,
  solicitacao_link_id uuid, valor_pago numeric, status_baixa text,
  atualizado_em timestamptz default now(), baixado_em timestamptz);
create table if not exists public.calibragem_auditoria (
  id uuid primary key default gen_random_uuid(), evento text not null, simulacao_id uuid,
  caso_id uuid, caso_compensacao_id uuid, chave_unificacao text, aluno_id uuid, cpf text,
  nome_aluno text, operador_anterior_email text, operador_anterior_nome text,
  operador_novo_email text, operador_novo_nome text, valor_caso numeric, motivo text,
  regra text, situacao_anterior jsonb, situacao_posterior jsonb, aprovado_por_email text,
  aprovado_por_nome text, registrado_por_email text, registrado_em timestamptz not null default now());
-- casos e usuarios: usados pela migration e pelas funcoes; a importacao usa
-- "create table if not exists", entao esta definicao prevalece quando existir.
create table if not exists public.usuarios (email text primary key, nome text, perfil text default 'operador',
  ativo boolean default true, recebe_novos_casos boolean default true);
create table if not exists public.casos (
  id uuid primary key default gen_random_uuid(), aluno_id uuid, matricula text default '1',
  cpf_limpo text, cpf text, nome text, operador_email text, operador_nome text, operador text,
  status_atual text default 'Sem contato', status_acionamento text, status_financeiro text,
  status_jornada text, nao_acionar boolean default false, valor_pago numeric default 0,
  quitado_em date, valor_quitado numeric, data_ultimo_acionamento date,
  giro_fidelizacao_ate date, chave_unificacao text, ultima_tabulacao_em timestamptz,
  caso_atualizado_em timestamptz, caso_atualizado_por text, encerrado_operacional boolean default false);

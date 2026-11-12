-- AMBIENTE ISOLADO — NIVELAMENTO V2 (20261112120000)
--
-- Roda num Postgres descartavel do CI. NAO fala com producao, NAO usa segredo.
--
-- LIMITE HONESTO: as dependencias abaixo (caso_protegido_redistribuicao,
-- caso_encerrado_operacional, aluno_saldo_pendente_detalhe, calibragem_teto_operador,
-- calibragem_e_gestao, internal.*) sao STUBS com a regra CONFIRMADA em producao
-- para o caso testado, nao o corpo de producao. O que este teste prova e a
-- logica NOVA (ocupacao, reposicao, troca, auditoria, gate, idempotencia), nao o
-- comportamento das funcoes reais. Equivalencia com producao: ver o pacote.
--
-- ORDEM: 01_ambiente.sql -> migration 20261112120000 -> 02_casos.sql
--        (a migration 20261112120100 e rodada no CI logo apos a primeira)

\set ON_ERROR_STOP on

-- 1. PAPEIS -------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon;          end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role;  end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;

-- 2. AUTH STUB ----------------------------------------------------------------
-- O e-mail vem de uma GUC de teste: set_config('teste.email', ..., false).
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select case when coalesce(current_setting('teste.email', true), '') = ''
              then null
              else jsonb_build_object('email', current_setting('teste.email', true)) end;
$$;
create or replace function auth.role() returns text language sql stable as $$
  select 'authenticated'::text;
$$;

-- 3. CRON STUB (pg_cron nao existe no CI) -------------------------------------
create schema if not exists cron;
create table cron.job (
  jobid    bigserial primary key,
  jobname  text unique,
  schedule text not null,
  command  text not null,
  active   boolean not null default true
);
create or replace function cron.schedule(p_name text, p_sched text, p_cmd text)
returns bigint language plpgsql as $$
declare v_id bigint;
begin
  insert into cron.job(jobname, schedule, command) values (p_name, p_sched, p_cmd)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid into v_id;
  return v_id;
end $$;
create or replace function cron.unschedule(p_id bigint) returns boolean language sql as $$
  with d as (delete from cron.job where jobid = p_id returning 1) select exists(select 1 from d);
$$;

-- 4. TABELAS -------------------------------------------------------------------
create table public.usuarios (
  email              text primary key,
  nome               text,
  perfil             text default 'operador',
  ativo              boolean default true,
  recebe_novos_casos boolean default true
);

create table public.casos (
  id                   uuid primary key default gen_random_uuid(),
  aluno_id             uuid,
  matricula            text default '1',
  cpf_limpo            text,
  cpf                  text,
  nome                 text,
  operador_email       text,
  operador_nome        text,
  operador             text,
  status_atual         text default 'Sem contato',
  status_acionamento   text,
  status_financeiro    text,
  status_jornada       text,
  nao_acionar          boolean default false,
  valor_pago           numeric default 0,
  quitado_em           date,
  valor_quitado        numeric,
  data_ultimo_acionamento date,
  giro_fidelizacao_ate date,
  chave_unificacao     text,
  ultima_tabulacao_em  timestamptz,
  caso_atualizado_em   timestamptz,
  caso_atualizado_por  text
);

-- Titulos: base da referencia de saldo (coalesce da ficha e cobranca).
create table public.acordos_titulos (
  id                       uuid primary key default gen_random_uuid(),
  aluno_id                 uuid,
  situacao                 text default 'ABERTO',
  valor_original           numeric,
  valor_em_aberto          numeric,
  saldo_corrigido          numeric,
  valor_cobranca_ajustado  numeric
);

create table public.baixas_pagamento (
  id           uuid primary key default gen_random_uuid(),
  aluno_id     text,
  aluno_cpf    text,
  valor_pago   numeric,
  status_baixa text,
  atualizado_em timestamptz default now(),
  baixado_em   timestamptz
);

create table public.calibragem_parametros (
  chave        text primary key,
  valor        jsonb,
  descricao    text,
  atualizado_em timestamptz,
  atualizado_por text
);

create table public.calibragem_auditoria (
  id                       uuid primary key default gen_random_uuid(),
  evento                   text not null,
  simulacao_id             uuid,
  caso_id                  uuid,
  caso_compensacao_id      uuid,
  chave_unificacao         text,
  aluno_id                 uuid,
  cpf                      text,
  nome_aluno               text,
  operador_anterior_email  text,
  operador_anterior_nome   text,
  operador_novo_email      text,
  operador_novo_nome       text,
  valor_caso               numeric,
  motivo                   text,
  regra                    text,
  situacao_anterior        jsonb,
  situacao_posterior       jsonb,
  aprovado_por_email       text,
  aprovado_por_nome        text,
  registrado_por_email     text,
  registrado_em            timestamptz not null default now()
);

create table public.historico_operadores_alunos (
  id                        bigserial primary key,
  chave_unificacao          text,
  nome_aluno                text,
  cpf_referencia            text,
  acao                      text,
  operador_nome             text,
  operador_email            text,
  operador_anterior_nome    text,
  operador_anterior_email   text,
  observacao                text,
  criado_em                 timestamptz default now()
);

-- Parametros: teto geral 700 (producao) e corte V2 aplicado pela migration.
insert into public.calibragem_parametros(chave, valor, descricao)
values ('limite_carteira', to_jsonb(700), 'teto geral');

-- 5. STUBS DE REGRAS (ver LIMITE HONESTO acima) ---------------------------------
create schema if not exists internal;

create or replace function public.calibragem_teto_operador(p_email text)
returns integer language sql stable as $$
  select coalesce(nullif(p.valor #>> '{}', '')::int, 500)
    from public.calibragem_parametros p where p.chave = 'limite_carteira'
  union all select 500 limit 1;
$$;

create or replace function public.calibragem_e_gestao() returns boolean
language sql stable as $$
  select lower(coalesce(current_setting('teste.email', true), '')) in
         ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br');
$$;

-- Encerrado: status_atual = 'ENCERRADO' (regra simplificada).
create or replace function public.caso_encerrado_operacional(p_cpf text, p_status_atual text,
  p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
returns boolean language sql immutable as $$
  select coalesce(p_status_atual,'') = 'ENCERRADO';
$$;

-- Protegido: nao_acionar, acordo fechado, ou ja pago. (Stub: regra CONFIRMADA
-- de caso_protegido_redistribuicao para estes campos.)
create or replace function public.caso_protegido_redistribuicao(p_cpf text, p_status_acionamento text,
  p_nao_acionar boolean, p_status_financeiro text, p_valor_pago numeric,
  p_quitado_em date, p_valor_quitado numeric)
returns boolean language sql immutable as $$
  select coalesce(p_nao_acionar,false)
      or coalesce(p_status_acionamento,'') = 'ACORDO FECHADO'
      or coalesce(p_valor_pago,0) > 0;
$$;

create or replace function public.caso_dentro_prazo_fidelizacao(p_data date)
returns boolean language sql immutable as $$ select false; $$;

create or replace function public.caso_em_giro_fidelizacao(p_data date)
returns boolean language sql stable as $$
  select p_data is not null and p_data >= current_date;
$$;

create or replace function internal.matricula_em_fidelizacao(p_aluno uuid, p_matricula text)
returns boolean language sql immutable as $$ select false; $$;

create or replace function internal.operador_pode_receber_caso(p_email text)
returns boolean language sql stable as $$ select true; $$;

create or replace function internal.carteira_geral_email()
returns text language sql immutable as $$ select 'carteira.geral@reativa.local'::text; $$;

create or replace function public.nome_operador_por_email(p_email text)
returns text language sql stable as $$
  select u.nome from public.usuarios u where lower(u.email) = lower(p_email) and u.ativo limit 1;
$$;

create or replace function public.saldo_titulos_aberto(p_cpf text)
returns numeric language sql stable as $$ select 0::numeric; $$;

-- Saldo cobravel do ALUNO: formula da ficha e cobranca, por titulo, mais nada.
create or replace function public.aluno_saldo_pendente_detalhe(p_aluno uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('total', round(coalesce(sum(
           coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)
         ), 0), 2))
    from public.acordos_titulos t
   where t.aluno_id = p_aluno and upper(coalesce(t.situacao,'')) = 'ABERTO';
$$;

-- Job 48 como esta em producao (nivelamento_automatico_gestao, 09:20 diario).
insert into cron.job(jobid, jobname, schedule, command)
values (48, 'nivelamento_automatico_gestao', '20 9 * * *', 'select public.nivelamento_automatico_gestao(10, true)');
select setval('cron.job_jobid_seq', 100);

-- Funcao com a forma de gate da familia calibragem_* (para testar o gate V2).
create or replace function public.calibragem_teste_gate() returns int
language plpgsql as $$
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissao.' using errcode = '42501';
  end if;
  return 1;
end $$;

-- Versao ANTERIOR de assumir_caso_livre (stub): o rollback precisa restaurar algo.
-- Em producao e o corpo real; aqui so existe para o backup ser gravado.
create or replace function public.assumir_caso_livre(p_caso_id uuid)
returns table(sucesso boolean, mensagem text, caso_liberado uuid)
language sql security definer set search_path = public, internal as $$
  select false, 'versao anterior (stub de teste)'::text, null::uuid;
$$;

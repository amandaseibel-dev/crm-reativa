-- AMBIENTE ISOLADO — migration 20261030090000_whatsapp_cadencia_continuidade_e_limite_5
--
-- Roda num Postgres descartável do CI (serviço do GitHub Actions).
-- NAO fala com produção, NAO usa segredo.
--
-- O QUE ESTE ARQUIVO CRIA:
--   1. Papéis Supabase (anon, authenticated, service_role).
--   2. Stub de auth.jwt() lido de GUC, para a função usar lower(p_operador).
--   3. Tabelas mínimas que whatsapp_cadencia_checar lê e escreve:
--      whatsapp_canais, whatsapp_conversas, whatsapp_mensagens,
--      whatsapp_abordagens, whatsapp_cadencia_bloqueios,
--      whatsapp_cadencia_liberacoes, whatsapp_config.
--   4. Alunos (stub), exigida como FK por whatsapp_conversas.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. PAPÉIS
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon;          end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated')  then create role authenticated;  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')   then create role service_role;   end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all     on tables    to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. STUBS auth
-- ---------------------------------------------------------------------------
create schema if not exists auth;

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select jsonb_build_object('email', coalesce(current_setting('teste.email', true), ''));
$$;

create or replace function auth.role() returns text language sql stable as $$
  select coalesce(current_setting('teste.role', true), 'authenticated');
$$;

-- ---------------------------------------------------------------------------
-- 3. SCHEMA MÍNIMO
-- ---------------------------------------------------------------------------

-- Stub para FK de whatsapp_conversas
create table public.alunos (
  id   uuid primary key default gen_random_uuid(),
  nome text,
  cpf  text
);

-- whatsapp_canais
create table public.whatsapp_canais (
  id                         uuid        primary key default gen_random_uuid(),
  sessao_chave               text        not null,
  display_phone_number       text        not null,
  apelido                    text        not null,
  ativo                      boolean     not null default true,
  conexao_status             text        not null default 'DESCONECTADO',
  conectado_em               timestamptz,
  modo                       text        not null default 'SOMENTE_RESPOSTAS',
  limite_abordagens_operador integer,
  limite_abordagens_canal    integer,
  janela_inicio              time,
  janela_fim                 time,
  criado_em                  timestamptz not null default now(),
  constraint ck_whatsapp_canal_modo
    check (modo in ('ATIVO_CONTROLADO','SOMENTE_RESPOSTAS','PAUSADO'))
);
create unique index ux_whatsapp_canais_sessao_chave on public.whatsapp_canais (sessao_chave);

-- whatsapp_conversas
create table public.whatsapp_conversas (
  id             uuid        primary key default gen_random_uuid(),
  canal_id       uuid        not null references public.whatsapp_canais(id),
  telefone_e164  text        not null,
  status         text        not null default 'NOVO',
  aluno_id       uuid        references public.alunos(id),
  criado_em      timestamptz not null default now(),
  constraint uq_whatsapp_conversa unique (canal_id, telefone_e164)
);

-- whatsapp_mensagens
create table public.whatsapp_mensagens (
  id               uuid        primary key default gen_random_uuid(),
  conversa_id      uuid        not null references public.whatsapp_conversas(id) on delete cascade,
  wamid            text        unique,
  direcao          text        not null,
  tipo             text        not null default 'text',
  texto            text,
  enviado_por_email text,
  sessao_chave     text,
  telefone_e164    text,
  origem           text        not null default 'TEMPO_REAL',
  timestamp_wa     timestamptz not null,
  criado_em        timestamptz not null default now()
);

-- whatsapp_abordagens
create table public.whatsapp_abordagens (
  id             uuid        primary key default gen_random_uuid(),
  canal_id       uuid        not null references public.whatsapp_canais(id)    on delete cascade,
  conversa_id    uuid        not null references public.whatsapp_conversas(id) on delete cascade,
  operador_email text        not null,
  dia            date        not null,
  criado_em      timestamptz not null default now(),
  constraint uq_whatsapp_abordagem unique (canal_id, conversa_id, dia)
);

-- whatsapp_cadencia_bloqueios
create table public.whatsapp_cadencia_bloqueios (
  id             uuid        primary key default gen_random_uuid(),
  canal_id       uuid        not null references public.whatsapp_canais(id) on delete cascade,
  conversa_id    uuid,
  operador_email text        not null,
  motivo         text        not null,
  criado_em      timestamptz not null default now(),
  constraint ck_whatsapp_bloqueio_motivo check (motivo in (
    'MODO_PAUSADO','MODO_SOMENTE_RESPOSTAS','FORA_DA_JANELA',
    'LIMITE_OPERADOR','LIMITE_CANAL','INTERVALO_MINIMO'))
);

-- whatsapp_cadencia_liberacoes
create table public.whatsapp_cadencia_liberacoes (
  id             uuid        primary key default gen_random_uuid(),
  canal_id       uuid        not null references public.whatsapp_canais(id) on delete cascade,
  operador_email text        not null,
  dia            date        not null,
  extra          integer     not null check (extra > 0),
  constraint uq_whatsapp_cadencia_liberacao unique (canal_id, operador_email, dia)
);

-- whatsapp_config (linha única)
create table public.whatsapp_config (
  id                          boolean     primary key default true,
  teto_abordagens_operador    integer     not null default 3,
  intervalo_minimo_envio_seg  integer     not null default 60,
  resposta_janela_horas       integer     not null default 24,
  constraint ck_whatsapp_config_linha_unica check (id)
);

-- Estado inicial de produção: teto=3, Comercial operador=2
insert into public.whatsapp_config (id, teto_abordagens_operador, intervalo_minimo_envio_seg, resposta_janela_horas)
values (true, 3, 60, 24);

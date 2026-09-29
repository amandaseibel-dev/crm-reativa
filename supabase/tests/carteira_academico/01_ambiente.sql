-- AMBIENTE ISOLADO para validar carteira_academico_* em PostgreSQL de verdade.
--
-- Só as tabelas e funções que o SQL sob teste toca, com as colunas que ele lê.
-- Não é uma cópia do schema de produção e não tenta ser: o que se prova aqui é
-- o COMPORTAMENTO do SQL, não o conteúdo do banco real.
\set ON_ERROR_STOP on

create schema if not exists public;

-- ---------------------------------------------------------------------------
-- OS PAPÉIS do Supabase. Sem eles o `revoke ... from public, anon` da migration
-- morre em `role "anon" does not exist` -- foi assim que este job reprovou da
-- primeira vez.
--
-- As DEFAULT PRIVILEGES também são reproduzidas de propósito: no Supabase elas
-- concedem EXECUTE a `anon` em toda função nova do schema. É por isso que
-- `revoke ... from public` NÃO basta -- a concessão é DIRETA ao papel, não via
-- PUBLIC. Sem reproduzir isso aqui, a asserção de permissão passaria por um
-- motivo falso: não haveria nada a revogar.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Portão de leitura. Aberto no teste: o controle de acesso tem os seus
-- próprios casos, e misturá-lo aqui esconderia falha de lógica atrás de 42501.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_2026_1_pode_ler() returns boolean
language sql stable as $$ select true $$;

create or replace function public.normalizar_status_acionamento(p text) returns text
language sql immutable as $$ select upper(coalesce(p,'')) $$;

create table public.alunos (
  id uuid primary key,
  cpf text,
  nome text,
  nome_aluno text,
  cpf_mascarado text,
  situacao_academica text,
  academico_atualizado_em timestamptz
);

create table public.acordos_titulos (
  id uuid primary key,
  aluno_id uuid,
  cpf text,
  documento text,
  situacao text,
  status text,
  vencimento date,
  origem_liquidacao text,
  acordo_id uuid,
  tipo_boleto text,
  valor_cobranca_ajustado numeric,
  saldo_corrigido numeric,
  valor_em_aberto numeric,
  valor_original numeric
);

create table public.prime_titulo_semestre (
  boleto text, semestre text, carrier_id integer,
  liquidado_em date, coletado_em timestamptz
);

create table public.prime_extrato (
  boleto text, portador integer, liquidado_em date, coletado_em timestamptz
);

create table public.pagamentos (
  titulo_numero text, aluno_id uuid, valor_pago numeric, data_pagamento date
);

create table public.prime_portador_membro (cpf text, portador integer);
create table public.acordos (aluno_id uuid, status text);
create table public.solicitacoes_confirmacao_pagamento (aluno_id text, status text);
create table public.casos (
  aluno_id uuid, status_atual text, status_acionamento text, status_jornada text
);
create table public.acordo_titulo_vinculo (titulo_id uuid);
create table public.parcelas (boleto text);

-- Armazenamento das consultas ao Prime (o que a 20260929000008 cria em prod).
create table public.prime_academico_consulta (
  id uuid primary key,
  aluno_id uuid,
  resultado text,
  consultado_em timestamptz,
  fonte text
);
create table public.prime_academico_vinculo (
  consulta_id uuid,
  ordem integer,
  status text,
  curso text,
  campus text,
  turno text,
  registration text
);

-- 2026/1 vem de uma função que já existe em produção; aqui ela é um dublê que
-- devolve exatamente as colunas lidas pelo universo.
create table public._c2026_1 (aluno_id uuid, cpf text, inadimplencia numeric, em_validacao numeric);
create or replace function public.carteira_2026_1_classificar()
returns table (aluno_id uuid, cpf text, inadimplencia numeric, em_validacao numeric)
language sql stable as $$
  select c.aluno_id, c.cpf, c.inadimplencia, c.em_validacao from public._c2026_1 c
$$;

// BANCADA DA COMPOSIÇÃO ACADÊMICA E DAS PENDÊNCIAS — PostgreSQL real (PGlite).
//
// O esqueleto tem só as colunas que as migrations em teste tocam, os papéis do
// Supabase (sem eles nenhum grant/revoke aplica) e dublês para o que não é o
// objeto do teste: `auth.jwt()`, o portão de leitura e
// `carteira_2026_1_classificar()`.
//
// POR QUE O CLASSIFICADOR É DUBLÊ. Ele é uma função de produção sem arquivo no
// repositório, e não é ele que está em teste: o que se prova aqui é que as
// funções novas AGREGAM o que ele devolve sem perder nem duplicar centavo. O
// dublê é uma tabela com as mesmas colunas, para o teste poder montar o caso
// exato que quer provar (título com valor em dois submotivos, aluno sem
// situação acadêmica, e assim por diante).
//
// Dados são FICTÍCIOS. O que se prova são as regras, não os números.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const lerRepo = (p) => readFileSync(resolve(AQUI, "..", "..", "..", "..", p), "utf8");
export const MIG = (n) => lerRepo(`supabase/migrations/${n}.sql`);
export const ROLL = (n) => lerRepo(`supabase/rollbacks/${n}.rollback.sql`);

export const SEIS_LINHAS = "20261005204500_carteira_safra_situacoes";
export const NOVA = "20261007193000_efetividade_composicao_academica_e_pendencias";
export const AJUSTES = "20261007230000_efetividade_regua_historica_e_camada_de_leitura";
// A politica de atualizacao: invalidacao por evento + dreno fora da requisicao.
export const INVALIDACAO = "20261007234000_efetividade_invalidacao_e_reconstrucao_sob_demanda";

export const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
export const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;

const ESQUELETO = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('test.jwt', true), '')::jsonb
$$;

-- O PORTÃO, como dublê: o teste liga e desliga por GUC para provar que as
-- funções novas o respeitam. A regra de autorização de verdade é a de
-- produção e não é objeto deste teste.
create or replace function public.carteira_2026_1_pode_ler() returns boolean
language sql stable as $$
  select coalesce(current_setting('test.pode_ler', true), 'on') = 'on'
$$;

create table public.alunos (
  id uuid primary key default gen_random_uuid(),
  nome text, cpf text,
  situacao_academica text,
  academico_atualizado_em timestamptz,
  responsavel_atual_email text
);

create table public.casos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid, operador_email text,
  status_atual text, status_acionamento text, status_jornada text,
  encerrado_operacional boolean not null default false
);

-- Dublês do que nao esta em teste aqui.
create or replace function public.normalizar_status_acionamento(p text) returns text
language sql immutable as $$ select upper(btrim(coalesce(p, ''))) $$;

create or replace function public.usuario_e_gestao() returns boolean
language sql stable as $$
  select coalesce(current_setting('test.gestao', true), 'on') = 'on'
$$;

create or replace function auth.role() returns text
language sql stable as $$ select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated') $$;

-- pg_cron nao existe no PGlite; a migration agenda a rotina horaria. O stub
-- registra a intencao para o teste poder conferir que a rotina foi criada.
create schema if not exists cron;
create table cron.job (jobid serial primary key, jobname text, schedule text, command text);
create or replace function cron.schedule(p_name text, p_sched text, p_cmd text)
returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into cron.job (jobname, schedule, command) values (p_name, p_sched, p_cmd)
    returning jobid into v;
  return v;
end $$;
create or replace function cron.unschedule(p_name text)
returns boolean language plpgsql as $$
begin delete from cron.job where jobname = p_name; return true; end $$;

create table public.acordos (
  id uuid primary key default gen_random_uuid(),
  status text, aluno_id uuid
);

create table public.parcelas (
  id uuid primary key default gen_random_uuid(),
  acordo_id uuid, valor numeric, status text, boleto text
);

create table public.pagamentos (
  id uuid primary key default gen_random_uuid(),
  titulo_numero text, valor_pago numeric, aluno_id uuid, data_pagamento date
);

create table public.prime_titulo_semestre (
  boleto text, semestre text, carrier_id integer, liquidado_em date, coletado_em timestamptz
);

-- A regua historica le o extrato e a lista do portador 166.
create table public.prime_extrato (
  boleto text, portador integer, liquidado_em date, coletado_em timestamptz
);
create table public.prime_portador_membro (
  portador integer, cpf text
);
create table public.solicitacoes_confirmacao_pagamento (
  id uuid primary key default gen_random_uuid(), aluno_id text, status text
);

create table public.acordo_titulo_vinculo (
  titulo_id uuid
);

create table public.acordos_titulos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid,
  cpf text,
  valor_original numeric,
  -- A regua historica le o saldo por esta precedencia, nesta ordem.
  valor_cobranca_ajustado numeric,
  saldo_corrigido numeric,
  valor_em_aberto numeric,
  situacao text,
  status text,
  tipo_boleto text,
  documento text,
  vencimento date,
  acordo_id uuid,
  origem_liquidacao text,
  atualizado_em timestamptz default now()
);

-- DUBLÊ DO CLASSIFICADOR DE 2026/1. Mesmas colunas que a função de produção
-- devolve e que as funções em teste consomem.
create table public.classificacao_2026_1 (
  aluno_id uuid, titulo_id uuid, valor_original numeric,
  ef_pago numeric default 0, ef_negociado numeric default 0,
  inadimplencia numeric default 0, em_validacao numeric default 0,
  academico numeric default 0, ef_convertido numeric default 0,
  faixa text
);
create or replace function public.carteira_2026_1_classificar()
returns setof public.classificacao_2026_1
language sql stable as $$ select * from public.classificacao_2026_1 $$;
`;

export async function montar() {
  const db = new PGlite();
  await db.exec(ESQUELETO);
  await db.exec(MIG(SEIS_LINHAS));
  await db.exec(MIG(NOVA));
  await db.exec(MIG(AJUSTES));
  await db.exec(MIG(INVALIDACAO));
  await db.exec("set timezone = 'UTC'");
  return db;
}

// ---------------------------------------------------- politica de atualizacao
export const invalidacoes = (db) =>
  qn(db, "select recorte, invalidado_em, motivo, origem, pedidos from public.carteira_efetividade_invalidacao order by recorte");
export const marcarDesatualizado = (db, motivo = "teste", origem = "TESTE") =>
  db.query("select public.carteira_efetividade_invalidar($1, $2)", [motivo, origem]);
export const drenar = (db) =>
  q1(db, "select public.carteira_efetividade_recalcular_pendentes() r").then((r) => r.r);
export const solicitar = (db) =>
  q1(db, "select public.carteira_efetividade_solicitar_atualizacao() r").then((r) => r.r);
export const fotoGeradaEm = (db, bloco, recorte) =>
  q1(db, "select gerado_em from public.carteira_efetividade_snapshot where bloco=$1 and recorte=$2",
     [bloco, recorte]).then((r) => r?.gerado_em || null);

export const comoPapel = async (db, papel = "authenticated") => { await db.query(`set role ${papel}`); };
export const voltarDono = (db) => db.query("reset role");
export const portao = (db, ligado) =>
  db.query("select set_config('test.pode_ler', $1, false)", [ligado ? "on" : "off"]);

// ---------------------------------------------------------------- semeadura
let seq = 0;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export async function aluno(db, { nome = "ALUNO", cpf = "11122233344", situacao = null,
                                  importadoEm = "2026-08-04T15:19:51Z", responsavel = null } = {}) {
  const id = uuid(++seq);
  await db.query(
    `insert into public.alunos (id, nome, cpf, situacao_academica, academico_atualizado_em,
                                responsavel_atual_email) values ($1,$2,$3,$4,$5,$6)`,
    [id, nome, cpf, situacao, situacao ? importadoEm : null, responsavel]);
  return id;
}

// Um título de 2024/2025: o universo exige tipo_boleto de graduação/pós e a
// série da Prime dando o ano.
export async function titulo(db, { alunoId, ano = "2024", valor = 1000, situacao = "EM_ABERTO",
                                   documento = null, acordoId = null, liquidacao = null,
                                   vencimento = "2024-03-10" } = {}) {
  const id = uuid(++seq);
  const doc = documento || String(4000000 + seq);
  await db.query(
    `insert into public.acordos_titulos (id, aluno_id, valor_original, situacao, tipo_boleto,
                                         documento, vencimento, acordo_id, origem_liquidacao)
     values ($1,$2,$3,$4,'Cursos de Graduação',$5,$6,$7,$8)`,
    [id, alunoId, valor, situacao, doc, vencimento, acordoId, liquidacao]);
  await db.query("insert into public.prime_titulo_semestre (boleto, semestre) values ($1,$2)",
    [doc, ano + "/1"]);
  return { id, documento: doc };
}

// Um titulo que a REGUA HISTORICA OFICIAL conta como aberto: situacao ABERTO,
// status em_aberto, sem acordo, sem vinculo, sem pagamento casado, sem
// liquidacao, saldo > 0 e portador 195.
export async function tituloHistorico(db, { alunoId, ano = "2024", saldo = 1000,
                                            vencimento = "2024-03-10", portador = 195,
                                            liquidadoEm = null, situacao = "ABERTO",
                                            status = "em_aberto" } = {}) {
  const id = uuid(++seq);
  const doc = String(6000000 + seq);
  await db.query(
    `insert into public.acordos_titulos (id, aluno_id, valor_original, saldo_corrigido, situacao,
                                         status, tipo_boleto, documento, vencimento)
     values ($1,$2,$3,$3,$4,$5,'Cursos de Graduação Presencial',$6,$7)`,
    [id, alunoId, saldo, situacao, status, doc, vencimento]);
  await db.query(
    `insert into public.prime_titulo_semestre (boleto, semestre, carrier_id, liquidado_em, coletado_em)
     values ($1,$2,$3,$4, now())`,
    [doc, ano + "/1", portador, liquidadoEm]);
  return { id, documento: doc };
}

export async function classificado(db, { alunoId, valor = 1000, pago = 0, negociado = 0,
                                         inadimplencia = 0, validacao = 0, academico = 0,
                                         convertido = 0, faixa = "INADIMPLENCIA",
                                         vencimento = "2026-03-10" } = {}) {
  const id = uuid(++seq);
  const doc = String(5000000 + seq);
  await db.query(
    `insert into public.acordos_titulos (id, aluno_id, valor_original, situacao, tipo_boleto,
                                         documento, vencimento)
     values ($1,$2,$3,'EM_ABERTO','Cursos de Graduação',$4,$5)`,
    [id, alunoId, valor, doc, vencimento]);
  await db.query(
    `insert into public.classificacao_2026_1 (aluno_id, titulo_id, valor_original, ef_pago,
       ef_negociado, inadimplencia, em_validacao, academico, ef_convertido, faixa)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [alunoId, id, valor, pago, negociado, inadimplencia, validacao, academico, convertido, faixa]);
  return { id, documento: doc };
}

export const composicao = (db, ano, sem = null) =>
  q1(db, "select public.carteira_em_aberto_por_status_academico($1,$2) r", [ano, sem])
    .then((x) => x.r);
export const pendencias = (db, ano, sem = null) =>
  q1(db, "select public.carteira_pendencias_por_motivo($1,$2) r", [ano, sem]).then((x) => x.r);
export const itens = (db, motivo, ano, sem = null, limite = 100, offset = 0) =>
  qn(db, "select * from public.carteira_pendencias_itens($1,$2,$3,$4,$5)",
     [motivo, ano, sem, limite, offset]);
export const seisLinhas = (db, ano, sem = null) =>
  q1(db, "select public.carteira_safra_situacoes($1,$2) r", [ano, sem]).then((x) => x.r);
export const recalcular = (db, recorte = null) =>
  q1(db, "select public.carteira_efetividade_recalcular($1) r", [recorte]).then((x) => x.r);
export const ler = (db, bloco, ano, sem = null) =>
  q1(db, "select public.carteira_efetividade_ler($1,$2,$3) r", [bloco, ano, sem]).then((x) => x.r);
export const itensLer = (db, motivo, ano, sem = null, limite = 50, offset = 0) =>
  qn(db, "select * from public.carteira_pendencias_itens_ler($1,$2,$3,$4,$5)",
     [motivo, ano, sem, limite, offset]);

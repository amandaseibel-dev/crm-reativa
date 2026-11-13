// Relatorio 2026/2 sem negociacao: classificacao de CPF e contagem por aluno_id.
// Roda a migration REAL sobre um esquema minimo (stubs de auth e das tabelas usadas).
// NENHUM DADO REAL: todos os valores abaixo sao ficticios.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const MIGRATION = ler("supabase/migrations/20261113000000_relatorio_2026_2_sem_negociacao.sql");
const ROLLBACK = ler("supabase/rollbacks/20261113000000_relatorio_2026_2_sem_negociacao.rollback.sql");

const GESTAO = "amanda.seibel@aelbra.com.br";

const ESQUEMA = `
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.email', true), '') $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'authenticated'::text $$;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  END $$;
  CREATE TABLE alunos (id uuid PRIMARY KEY, unidade text);
  CREATE TABLE acordos_titulos (
    id uuid PRIMARY KEY, aluno_id uuid, cpf text, vencimento date,
    saldo_corrigido numeric, valor_em_aberto numeric, valor_original numeric,
    tipo_boleto text, situacao text, status text, acordo_id uuid
  );
  CREATE TABLE acordo_titulo_vinculo (titulo_id uuid);
  CREATE TABLE casos (aluno_id uuid, status_atual text, status_acionamento text, status_jornada text);
  CREATE TABLE solicitacoes_confirmacao_pagamento (aluno_id text, status text);
  CREATE OR REPLACE FUNCTION public.normalizar_status_acionamento(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT upper(coalesce(t,'')) $$;
  CREATE OR REPLACE FUNCTION public.unaccent(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT t $$;
`;

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c";
const D = "00000000-0000-0000-0000-00000000000d";
const E = "00000000-0000-0000-0000-00000000000e";
const F = "00000000-0000-0000-0000-00000000000f";
const G = "00000000-0000-0000-0000-000000000010";

const titulo = (id, aluno, cpf, saldo, venc = "2026-08-10") => [id, aluno, cpf, saldo, venc];

const CENARIO = [
  titulo("10000000-0000-0000-0000-000000000001", A, "12345678901", 100),
  titulo("10000000-0000-0000-0000-000000000002", A, "12345678901", 50),
  titulo("10000000-0000-0000-0000-000000000003", B, "12345678901", 200),
  titulo("10000000-0000-0000-0000-000000000004", C, null, 300),
  titulo("10000000-0000-0000-0000-000000000005", D, "111.111.111-11", 40),
  titulo("10000000-0000-0000-0000-000000000006", E, "1234567890123", 60),
  titulo("10000000-0000-0000-0000-000000000007", F, "98765432100", 10),
  titulo("10000000-0000-0000-0000-000000000008", F, "11122233344", 20),
  titulo("10000000-0000-0000-0000-000000000009", G, "55555555555", 999, "2026-06-10"),
];

async function criarBancoComCenario() {
  const db = new PGlite();
  await db.exec(ESQUEMA);
  for (const id of [A, B, C, D, E, F, G]) {
    await db.query("INSERT INTO alunos (id, unidade) VALUES ($1, 'OSASCO')", [id]);
  }
  for (const [id, aluno, cpf, saldo, venc] of CENARIO) {
    await db.query(
      `INSERT INTO acordos_titulos (id, aluno_id, cpf, vencimento, saldo_corrigido, valor_em_aberto, valor_original, tipo_boleto, situacao, status, acordo_id)
       VALUES ($1, $2, $3, $4, $5, $5, $5, 'Cursos de Graduação Presencial', 'ABERTO', 'em_aberto', NULL)`,
      [id, aluno, cpf, venc, saldo],
    );
  }
  await db.exec(MIGRATION);
  return db;
}

async function chamarRelatorio(db, email = GESTAO) {
  await db.exec(`SET app.email = '${email}'`);
  const { rows } = await db.query("SELECT relatorio_mensalidades_2026_2_sem_negociacao() AS j");
  return rows[0].j;
}

describe("relatorio 2026/2: classificacao de CPF e contagem por aluno", () => {
  let db;

  beforeEach(async () => {
    db = await criarBancoComCenario();
  });

  afterEach(async () => {
    await db?.close();
  });

  it("conta alunos pelo aluno_id: titulos repetidos do mesmo aluno nao duplicam", async () => {
    const j = await chamarRelatorio(db);
    // A (2 titulos), B, C, D, E, F (2 titulos). G esta fora do semestre.
    expect(j.alunos_unicos_semestre).toBe(6);
    expect(j.mensalidades_total).toBe(8);
  });

  it("nao exclui titulos nem alunos por inconsistencia de CPF: saldo e elegibilidade preservados", async () => {
    const j = await chamarRelatorio(db);
    expect(Number(j.saldo_total)).toBe(780);
    expect(j.mensalidades_total).toBe(8);
  });

  it("classifica CPF valido, compartilhado, ausente, invalido e divergente", async () => {
    const d = (await chamarRelatorio(db)).cpf_diagnostico;
    expect(d.cpfs_validos).toBe(3);
    expect(d.cpfs_compartilhados).toBe(1);
    expect(d.alunos_cpf_invalido_ou_ausente).toBe(3);
    expect(d.alunos_com_cpf_divergente).toBe(1);
    expect(d.titulos_cpf_invalido_ou_ausente).toBe(3);
  });

  it("CPF compartilhado nao conta duas vezes nos CPFs validos", async () => {
    const d = (await chamarRelatorio(db)).cpf_diagnostico;
    // 12345678901 aparece em A e B: conta uma vez como CPF valido e uma como compartilhado.
    expect(d.cpfs_validos).toBe(3);
    expect(d.cpfs_compartilhados).toBe(1);
  });

  it("nao e gestao: a RPC recusa com 42501", async () => {
    await expect(chamarRelatorio(db, "outra.pessoa@aelbra.com.br")).rejects.toThrow(/restrito a gestao|42501/);
  });

  it("grants: authenticated executa; anon e public nao", async () => {
    const q = async (role) => {
      const { rows } = await db.query(
        `SELECT has_function_privilege($1, 'public.relatorio_mensalidades_2026_2_sem_negociacao()', 'EXECUTE') AS ok`,
        [role],
      );
      return rows[0].ok;
    };
    expect(await q("authenticated")).toBe(true);
    expect(await q("anon")).toBe(false);
  });

  it("rollback remove os objetos de 2026/2 quando nao ha snapshot", async () => {
    await db.exec(ROLLBACK);
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'relatorio_mensalidades_2026_2%' OR proname = '_relatorio_2026_2_eleg'",
    );
    expect(rows[0].n).toBe(0);
  });

  it("rollback aborta quando ha snapshot capturado, sem apagar nada", async () => {
    await db.exec(`INSERT INTO relatorio_mens_2026_2_snapshot (dia, cpfs, alunos, mensalidades, saldo) VALUES ('2026-11-13', 1, 1, 1, 1)`);
    await expect(db.exec(ROLLBACK)).rejects.toThrow(/rollback abortado/);
    await db.exec("ROLLBACK");
    const { rows } = await db.query("SELECT count(*)::int AS n FROM relatorio_mens_2026_2_snapshot");
    expect(rows[0].n).toBe(1);
  });
});

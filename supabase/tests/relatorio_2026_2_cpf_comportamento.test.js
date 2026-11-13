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
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('app.role', true), ''), 'authenticated')::text $$;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  END $$;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
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
  titulo("10000000-0000-0000-0000-000000000001", A, "52998224725", 100),
  titulo("10000000-0000-0000-0000-000000000002", A, "52998224725", 50),
  titulo("10000000-0000-0000-0000-000000000003", B, "52998224725", 200),
  titulo("10000000-0000-0000-0000-000000000004", C, null, 300),
  titulo("10000000-0000-0000-0000-000000000005", D, "111.111.111-11", 40),
  titulo("10000000-0000-0000-0000-000000000006", E, "1234567890123", 60),
  titulo("10000000-0000-0000-0000-000000000007", F, "98765432100", 10),
  titulo("10000000-0000-0000-0000-000000000008", F, "11144477735", 20),
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
    expect(d.alunos_sem_cpf).toBe(1);
    expect(d.alunos_cpf_invalido).toBe(2);
    expect(d.alunos_com_cpf_divergente).toBe(1);
    expect(d.titulos_sem_cpf_ou_invalido).toBe(3);
  });

  it("CPF compartilhado nao conta duas vezes nos CPFs validos", async () => {
    const d = (await chamarRelatorio(db)).cpf_diagnostico;
    // 12345678901 aparece em A e B: conta uma vez como CPF valido e uma como compartilhado.
    expect(d.cpfs_validos).toBe(3);
    expect(d.cpfs_compartilhados).toBe(1);
  });

  it("aluno sem CPF fica no total de alunos e nao entra como CPF 00000000000", async () => {
    const j = await chamarRelatorio(db);
    expect(j.alunos_unicos_semestre).toBe(6);
    // distintos validos: 52998224725 (A,B) e os dois de F
    expect(j.cpfs_semestre).toBe(3);
    expect(j.cpf_diagnostico.alunos_sem_cpf).toBe(1);
  });

  it("CPF compartilhado nao mistura saldo entre alunos: cada aluno soma so os proprios titulos", async () => {
    await db.exec(`SET app.email = '${GESTAO}'`);
    const { rows } = await db.query(
      `SELECT aluno_id, sum(saldo)::numeric AS total, count(*)::int AS titulos
       FROM public._relatorio_2026_2_eleg() WHERE aluno_id IN ($1, $2) GROUP BY aluno_id ORDER BY aluno_id`,
      [A, B],
    );
    const porAluno = Object.fromEntries(rows.map((r) => [r.aluno_id, { total: Number(r.total), titulos: r.titulos }]));
    expect(porAluno[A]).toEqual({ total: 150, titulos: 2 });
    expect(porAluno[B]).toEqual({ total: 200, titulos: 1 });
  });

  it("CPF com mais de 11 digitos nao e truncado nem associado a outro CPF valido", async () => {
    await db.exec(`SET app.email = '${GESTAO}'`);
    const { rows } = await db.query(
      `SELECT DISTINCT cpf FROM public._relatorio_2026_2_eleg() WHERE aluno_id = $1`,
      [E],
    );
    expect(rows.map((r) => r.cpf)).toEqual(["1234567890123"]);
  });

  it("funcao de validacao: digitos verificadores e sequencias repetidas", async () => {
    const q = async (c) => (await db.query("SELECT public._cpf_valido_2026_2($1) AS ok", [c])).rows[0].ok;
    expect(await q("52998224725")).toBe(true);
    expect(await q("98765432100")).toBe(true);
    expect(await q("12345678901")).toBe(false);
    expect(await q("11122233344")).toBe(false);
    expect(await q("00000000000")).toBe(false);
    expect(await q("11111111111")).toBe(false);
    expect(await q("1234567890")).toBe(false);
    expect(await q("1234567890123")).toBe(false);
  });

  it("CPF invalido com menos de 11 digitos e preservado, sem completar com zeros", async () => {
    const H = "00000000-0000-0000-0000-000000000011";
    const TH = "10000000-0000-0000-0000-0000000000aa";
    await db.exec(`SET app.email = '${GESTAO}'`);
    await db.query("INSERT INTO alunos (id, unidade) VALUES ($1, 'OSASCO')", [H]);
    await db.query(
      `INSERT INTO acordos_titulos (id, aluno_id, cpf, vencimento, saldo_corrigido, valor_em_aberto, valor_original, tipo_boleto, situacao, status, acordo_id)
       VALUES ($2, $1, '123.456.789-0', '2026-09-10', 5, 5, 5, 'Cursos de Graduação Presencial', 'ABERTO', 'em_aberto', NULL)`,
      [H, TH],
    );
    const { rows } = await db.query(`SELECT DISTINCT cpf FROM public._relatorio_2026_2_eleg() WHERE aluno_id = $1`, [H]);
    expect(rows.map((r) => r.cpf)).toEqual(["1234567890"]);
  });

  it("CPF vazio, ilegivel ou so zeros conta como sem CPF, nunca como CPF invalido nem 00000000000", async () => {
    await db.exec(`SET app.email = '${GESTAO}'`);
    const I = "00000000-0000-0000-0000-000000000021";
    const J = "00000000-0000-0000-0000-000000000022";
    const K = "00000000-0000-0000-0000-000000000023";
    for (const id of [I, J, K]) await db.query("INSERT INTO alunos (id, unidade) VALUES ($1, 'OSASCO')", [id]);
    const titulos = [
      ["10000000-0000-0000-0000-0000000000b1", I, "-"],
      ["10000000-0000-0000-0000-0000000000b2", J, "000.000.000-00"],
      ["10000000-0000-0000-0000-0000000000b3", K, null],
      ["10000000-0000-0000-0000-0000000000b4", K, "529.982.247-25"],
    ];
    for (const [id, aluno, cpf] of titulos) {
      await db.query(
        `INSERT INTO acordos_titulos (id, aluno_id, cpf, vencimento, saldo_corrigido, valor_em_aberto, valor_original, tipo_boleto, situacao, status, acordo_id)
         VALUES ($1, $2, $3, '2026-09-10', 5, 5, 5, 'Cursos de Graduação Presencial', 'ABERTO', 'em_aberto', NULL)`,
        [id, aluno, cpf],
      );
    }
    const j = await chamarRelatorio(db);
    // sem CPF: C (nulo), I (traco). K tem um CPF valido, entao nao e sem CPF.
    expect(j.cpf_diagnostico.alunos_sem_cpf).toBe(2);
    // invalidos: D (repetido), E (13 digitos) e J (zeros).
    expect(j.cpf_diagnostico.alunos_cpf_invalido).toBe(3);
    expect(j.cpf_diagnostico.cpfs_validos).toBe(3);
    // CPFs distintos validos: 52998224725 (A, B, K), 98765432100 (F) e 11144477735 (F)
    expect(j.cpfs_semestre).toBe(3);
    expect(j.alunos_unicos_semestre).toBe(9);
  });

  it("nao e gestao: a RPC recusa com 42501", async () => {
    await expect(chamarRelatorio(db, "outra.pessoa@aelbra.com.br")).rejects.toThrow(/restrito a gestao|42501/);
  });

  it("grants: RPCs executam para authenticated; anon e public nao", async () => {
    const q = async (role, fn) => {
      const { rows } = await db.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
      return rows[0].ok;
    };
    for (const fn of ["public.relatorio_mensalidades_2026_2_sem_negociacao()", "public.relatorio_mensalidades_2026_2_capturar()"]) {
      expect(await q("authenticated", fn)).toBe(true);
      expect(await q("anon", fn)).toBe(false);
    }
  });

  it("funcao de validacao de CPF nao e executavel por anon nem authenticated", async () => {
    for (const role of ["anon", "authenticated"]) {
      const { rows } = await db.query(
        `SELECT has_function_privilege($1, 'public._cpf_valido_2026_2(text)', 'EXECUTE') AS ok`,
        [role],
      );
      expect(rows[0].ok, role).toBe(false);
    }
  });

  it("helper de elegibilidade nao e executavel por authenticated nem anon (expoe CPF)", async () => {
    const q = async (role) => {
      const { rows } = await db.query(
        `SELECT has_function_privilege($1, 'public._relatorio_2026_2_eleg()', 'EXECUTE') AS ok`,
        [role],
      );
      return rows[0].ok;
    };
    expect(await q("authenticated")).toBe(false);
    expect(await q("anon")).toBe(false);
  });

  it("helper recusa chamada fora da gestao mesmo se executado (portao interno)", async () => {
    await db.exec(`SET app.email = 'outra.pessoa@aelbra.com.br'; SET app.role = 'authenticated'`);
    await expect(db.query("SELECT * FROM public._relatorio_2026_2_eleg()")).rejects.toThrow(/restrita a gestao|42501/);
  });

  it("captura recusa usuario comum e aceita service_role", async () => {
    await db.exec(`SET app.email = 'outra.pessoa@aelbra.com.br'; SET app.role = 'authenticated'`);
    await expect(db.query("SELECT relatorio_mensalidades_2026_2_capturar()")).rejects.toThrow(/restrito a gestao|42501/);
    await db.exec(`SET app.email = ''; SET app.role = 'service_role'`);
    const { rows } = await db.query("SELECT relatorio_mensalidades_2026_2_capturar() AS j");
    expect(rows[0].j.alunos).toBe(6);
  });

  it("snapshot tem RLS ativa e sem acesso direto para authenticated", async () => {
    const { rows } = await db.query(
      `SELECT c.relrowsecurity AS rls,
              has_table_privilege('authenticated', c.oid, 'SELECT') AS sel,
              has_table_privilege('authenticated', c.oid, 'DELETE') AS del
       FROM pg_class c WHERE c.oid = 'public.relatorio_mens_2026_2_snapshot'::regclass`,
    );
    expect(rows[0].rls).toBe(true);
    expect(rows[0].sel).toBe(false);
    expect(rows[0].del).toBe(false);
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        const { rows: r } = await db.query(
          `SELECT has_table_privilege($1, 'public.relatorio_mens_2026_2_snapshot'::regclass, $2) AS ok`,
          [role, priv],
        );
        expect(r[0].ok, `${role} ${priv}`).toBe(false);
      }
    }
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

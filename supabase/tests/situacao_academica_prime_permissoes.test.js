// MIGRATION E PERMISSÕES do armazenamento da situação acadêmica, em Postgres
// isolado (PGlite).
//
// O QUE ESTE ARQUIVO PROVA:
//   1. a migration aplica limpa, do zero;
//   2. `authenticated` (operador logado) LÊ, porque é dado operacional e
//      escondê-lo produziria a cobrança errada;
//   3. `authenticated` NÃO GRAVA -- nem por INSERT/UPDATE/DELETE direto nas
//      tabelas, nem chamando a RPC de escrita;
//   4. `anon` não lê nada;
//   5. a unicidade é por (consulta_id, ordem), e NÃO por curso+campus+turno --
//      três vínculos idênticos com status diferentes precisam caber os três;
//   6. a RPC de escrita guarda a matrícula EM CADA LINHA.
//
// PGLITE É POSTGRES DE VERDADE E NÃO SUBSTITUI O SUPABASE: aqui não há
// PostgREST nem os papéis reais com suas heranças. O que se prova é a autoridade
// dos papéis DENTRO do banco -- e essa parte é a mesma.
//
// NENHUM DADO REAL. As matrículas e cursos abaixo são inventados.
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  resolve(AQUI, "..", "migrations", "20260929000008_situacao_academica_prime_armazenamento.sql"),
  "utf8",
);

const ALUNO = "00000000-0000-4000-8000-000000000001";

async function bancada() {
  const db = await PGlite.create();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema if not exists auth;
    create table public.alunos (id uuid primary key, cpf text);
    insert into public.alunos values ('${ALUNO}', '11111111111');
  `);
  // Reproduz produção: os papéis têm USAGE mas NÃO CREATE em public.
  await db.exec(`
    revoke create on schema public from public, anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    grant select, insert, update, delete on public.alunos to authenticated, service_role;
  `);

  // `auth.role()` do Supabase, dublada: devolve o papel efetivo. É ela que a
  // RPC de escrita consulta, então precisa responder de verdade.
  await db.exec(`
    create or replace function auth.role() returns text
      language sql stable as $$ select current_setting('role', true) $$;
    grant usage on schema auth to anon, authenticated, service_role;
  `);

  await db.exec(SQL);

  // As tabelas nascem depois dos grants padrão, então o GRANT de leitura vai
  // aqui -- é o que o Supabase faz por default privileges em produção. O que o
  // teste mede é se a RLS segura a escrita mesmo COM o grant de tabela.
  await db.exec(`
    grant select, insert, update, delete on public.prime_academico_consulta to authenticated, anon;
    grant select, insert, update, delete on public.prime_academico_vinculo  to authenticated, anon;
  `);
  // O EXECUTE das funcoes NAO e concedido aqui de proposito: quem concede e a
  // propria migration. Se ela parar de conceder, estes testes caem -- que e
  // exatamente o aviso que se quer.

  db.como = async (papel, sql, args = []) => {
    try {
      await db.exec(`set role ${papel};`);
      const r = await db.query(sql, args);
      return { ok: true, linhas: r.rows };
    } catch (e) { return { ok: false, erro: e.message }; }
    finally { await db.exec(`reset role;`); }
  };

  db.gravar = (vinculos, resultado = "COM_VINCULOS") => db.como("service_role",
    `select public.prime_academico_registrar($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) id`,
    [ALUNO, "111.111.111-11", "900000001", resultado, null, 200, vinculos.length,
     JSON.stringify(vinculos), "gestao@exemplo.test"]);

  return db;
}

const vinculo = (o = {}) => ({
  registration: "900000001", course: "CURSO X", campus: "CAMPUS Y", shift: "NOITE",
  status: "Trancado", admissionYear: 2023, graduated: false, ...o });

describe("migration aplica e cria o que promete", () => {
  let db;
  beforeAll(async () => { db = await bancada(); }, 60000);

  it("as duas tabelas existem com RLS ligada", async () => {
    const r = await db.query(`
      select relname, relrowsecurity from pg_class
       where relname in ('prime_academico_consulta','prime_academico_vinculo')
       order by relname`);
    expect(r.rows.map((x) => x.relname)).toEqual(
      ["prime_academico_consulta", "prime_academico_vinculo"]);
    for (const linha of r.rows) expect(linha.relrowsecurity, linha.relname).toBe(true);
  });

  it("a unicidade é por (consulta_id, ordem), NÃO por curso+campus+turno", async () => {
    const r = await db.query(`
      select pg_get_constraintdef(oid) d from pg_constraint
       where conname = 'uq_prime_academico_vinculo_ordem'`);
    expect(r.rows[0].d).toMatch(/UNIQUE \(consulta_id, ordem\)/i);
  });

  it("não existe coluna de 'situação do aluno' — a situação é por vínculo", async () => {
    const r = await db.query(`
      select column_name from information_schema.columns
       where table_name = 'prime_academico_consulta'`);
    const nomes = r.rows.map((x) => x.column_name);
    expect(nomes).not.toContain("situacao_academica");
    expect(nomes).not.toContain("status");
  });
});

describe("escrita: só service_role", () => {
  let db;
  beforeAll(async () => { db = await bancada(); }, 60000);

  it("service_role grava, e a matrícula fica EM CADA LINHA", async () => {
    const r = await db.gravar([
      vinculo({ registration: "900000001", status: "Trancado" }),
      vinculo({ registration: "900000002", status: "Formado", graduated: true }),
    ]);
    expect(r.ok, r.erro).toBe(true);

    const linhas = (await db.query(
      `select ordem, registration, status, graduated from public.prime_academico_vinculo order by ordem`)).rows;
    expect(linhas.map((l) => l.registration)).toEqual(["900000001", "900000002"]);
    expect(linhas.map((l) => Number(l.ordem))).toEqual([1, 2]);
    expect(linhas[1].graduated).toBe(true);
  });

  it("três vínculos com curso, campus e turno IDÊNTICOS cabem os três", async () => {
    // É o caso que a unicidade errada apagaria. Status diferentes, um nulo.
    const r = await db.gravar([
      vinculo({ status: "Reopção de Curso" }),
      vinculo({ status: "Cancelado" }),
      vinculo({ status: null }),
    ]);
    expect(r.ok, r.erro).toBe(true);
    const id = r.linhas[0].id;
    const linhas = (await db.query(
      `select status from public.prime_academico_vinculo where consulta_id = $1 order by ordem`, [id])).rows;
    expect(linhas).toHaveLength(3);
    expect(linhas.map((l) => l.status)).toEqual(["Reopção de Curso", "Cancelado", null]);
  });

  it("status vazio vira NULL — 'não informado', e não string vazia", async () => {
    const r = await db.gravar([vinculo({ status: "" })]);
    const linhas = (await db.query(
      `select status from public.prime_academico_vinculo where consulta_id = $1`, [r.linhas[0].id])).rows;
    expect(linhas[0].status).toBeNull();
  });

  it("authenticated NÃO consegue chamar a RPC de escrita", async () => {
    const r = await db.como("authenticated",
      `select public.prime_academico_registrar($1,$2,null,'COM_VINCULOS',null,200,1,'[]'::jsonb,null)`,
      [ALUNO, "111.111.111-11"]);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/apenas service_role|permission denied/i);
  });

  it("anon NÃO consegue chamar a RPC de escrita", async () => {
    const r = await db.como("anon",
      `select public.prime_academico_registrar($1,$2,null,'COM_VINCULOS',null,200,1,'[]'::jsonb,null)`,
      [ALUNO, "111.111.111-11"]);
    expect(r.ok).toBe(false);
  });

  it("resultado fora do domínio é recusado, em vez de gravar estado inventado", async () => {
    const r = await db.gravar([], "TALVEZ");
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/resultado invalido/i);
  });
});

describe("leitura e escrita direta nas tabelas", () => {
  let db;
  beforeAll(async () => {
    db = await bancada();
    await db.gravar([vinculo({ status: "Trancado" })]);
  }, 60000);

  it("authenticated LÊ pela RPC — é dado operacional", async () => {
    const r = await db.como("authenticated",
      `select public.prime_academico_ultima($1) j`, [ALUNO]);
    expect(r.ok, r.erro).toBe(true);
    const j = r.linhas[0].j;
    expect(j.resultado).toBe("COM_VINCULOS");
    expect(j.vinculos).toHaveLength(1);
    expect(j.vinculos[0].registration).toBe("900000001");
    expect(j.vinculos[0].status).toBe("Trancado");
  });

  it("authenticated NÃO grava direto nas tabelas, mesmo tendo GRANT", async () => {
    // O GRANT de tabela existe (é o default do Supabase). Quem segura é a RLS:
    // há policy de SELECT e nenhuma de INSERT/UPDATE/DELETE.
    const ins = await db.como("authenticated",
      `insert into public.prime_academico_consulta (aluno_id, cpf, resultado)
       values ($1,'11111111111','COM_VINCULOS')`, [ALUNO]);
    expect(ins.ok).toBe(false);
    expect(ins.erro).toMatch(/row-level security|violates/i);

    const upd = await db.como("authenticated",
      `update public.prime_academico_vinculo set status = 'Formado'`);
    expect(upd.ok && (await db.query(
      `select count(*) c from public.prime_academico_vinculo where status='Formado'`)).rows[0].c)
      .not.toBe("1");

    const del = await db.como("authenticated", `delete from public.prime_academico_vinculo`);
    expect(del.ok && Number((await db.query(
      `select count(*) c from public.prime_academico_vinculo`)).rows[0].c)).not.toBe(0);
  });

  it("o dado continua lá depois das tentativas de escrita do operador", async () => {
    const n = Number((await db.query(
      `select count(*) c from public.prime_academico_vinculo`)).rows[0].c);
    expect(n).toBe(1);
    const s = (await db.query(`select status from public.prime_academico_vinculo`)).rows[0].status;
    expect(s).toBe("Trancado");
  });

  it("anon não lê nada", async () => {
    const r = await db.como("anon", `select * from public.prime_academico_vinculo`);
    // Sem policy para anon: ou erra, ou devolve vazio. Nunca devolve linha.
    expect(r.ok ? r.linhas.length : 0).toBe(0);
  });
});

describe("a leitura distingue os estados", () => {
  let db;
  beforeAll(async () => { db = await bancada(); }, 60000);

  it("aluno nunca consultado devolve NULL — e isso é diferente de 'sem vínculo'", async () => {
    const r = await db.query(`select public.prime_academico_ultima($1) j`,
      ["00000000-0000-4000-8000-0000000000ff"]);
    expect(r.rows[0].j).toBeNull();
  });

  it("SEM_RESULTADO devolve consulta com lista vazia, não NULL", async () => {
    await db.gravar([], "SEM_RESULTADO");
    const j = (await db.query(`select public.prime_academico_ultima($1) j`, [ALUNO])).rows[0].j;
    expect(j).not.toBeNull();
    expect(j.resultado).toBe("SEM_RESULTADO");
    expect(j.vinculos).toEqual([]);
  });

  it("falha NÃO apaga a consulta boa anterior — a leitura pega a mais recente", async () => {
    await db.gravar([vinculo({ status: "Trancado" })], "COM_VINCULOS");
    const boa = (await db.query(`select public.prime_academico_ultima($1) j`, [ALUNO])).rows[0].j;
    expect(boa.resultado).toBe("COM_VINCULOS");

    await db.gravar([], "FALHA_COMUNICACAO");
    const agora = (await db.query(`select public.prime_academico_ultima($1) j`, [ALUNO])).rows[0].j;
    expect(agora.resultado).toBe("FALHA_COMUNICACAO");

    // e a boa continua no histórico, não foi sobrescrita
    const n = Number((await db.query(
      `select count(*) c from public.prime_academico_consulta where resultado='COM_VINCULOS'`)).rows[0].c);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

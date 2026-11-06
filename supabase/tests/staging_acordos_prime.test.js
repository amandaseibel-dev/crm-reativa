// RLS, grants e isolamento do staging de ACORDOS — executado de verdade,
// num Postgres real (PGlite), nesta máquina e no CI.
//
// POR QUE EXISTE: a proposta ganhou seção de segurança (RLS, grants, policies,
// security_invoker). Revisão por leitura não prova ACL — grant herdado,
// TRUNCATE que a RLS não cobre e view com `security_invoker` desligado são
// exatamente os erros que passam numa leitura e aparecem num banco.
//
// O MESMO SQL roda no job do CI contra um Postgres de serviço
// (supabase/tests/staging_acordos_prime/*.sql, via psql). Aqui ele roda em
// PGlite para o resultado existir também antes do push. As meta-instruções do
// psql (\set, \echo) são removidas — PGlite não as entende, e elas não mudam o
// que é medido.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const semMetaPsql = (sql) =>
  sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("\\"))
    .join("\n");

const AMBIENTE = semMetaPsql(readFileSync("supabase/tests/staging_acordos_prime/01_ambiente.sql", "utf8"));
const PROPOSTA = semMetaPsql(readFileSync("supabase/propostas/PROPOSTA_staging_acordos_prime.sql", "utf8"));
const CASOS = semMetaPsql(readFileSync("supabase/tests/staging_acordos_prime/02_casos.sql", "utf8"));

describe("staging de ACORDOS: a proposta aplica e fecha o acesso", () => {
  let db;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(AMBIENTE);
    await db.exec(PROPOSTA);
  }, 180000);

  it("a proposta aplica inteira, sem erro", async () => {
    const r = await db.query(`
      select count(*)::int as n from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('acordos_prime_staging', 'acordos_prime_staging_criticas', 'acordos_prime_staging_atual')
    `);
    expect(r.rows[0].n).toBe(3);
  });

  it("RLS está ligada nas duas tabelas", async () => {
    const r = await db.query(`
      select c.relname, c.relrowsecurity from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('acordos_prime_staging', 'acordos_prime_staging_criticas')
      order by 1
    `);
    expect(r.rows).toEqual([
      { relname: "acordos_prime_staging", relrowsecurity: true },
      { relname: "acordos_prime_staging_criticas", relrowsecurity: true },
    ]);
  });

  it("a armadilha do TRUNCATE está fechada — e DELETE também", async () => {
    // RLS NÃO cobre TRUNCATE, e tabela nova em `public` nasce com ele para
    // `authenticated`. Sem o revoke, qualquer logado apaga o staging inteiro
    // sem violar policy nenhuma.
    const r = await db.query(`
      select table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee in ('anon', 'authenticated', 'PUBLIC')
        and table_name in ('acordos_prime_staging', 'acordos_prime_staging_criticas', 'acordos_prime_staging_atual')
        and privilege_type in ('TRUNCATE', 'DELETE', 'REFERENCES', 'TRIGGER')
    `);
    expect(r.rows).toEqual([]);
  });

  it("anon não tem privilégio nenhum", async () => {
    const r = await db.query(`
      select table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'anon'
        and table_name in ('acordos_prime_staging', 'acordos_prime_staging_criticas', 'acordos_prime_staging_atual')
    `);
    expect(r.rows).toEqual([]);
  });

  it("authenticated não escreve no staging append-only", async () => {
    const r = await db.query(`
      select privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'authenticated'
        and table_name = 'acordos_prime_staging'
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
    `);
    expect(r.rows).toEqual([]);
  });

  it("o UPDATE das críticas é por coluna, e não alcança a evidência", async () => {
    const r = await db.query(`
      select column_name from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'acordos_prime_staging_criticas'
        and grantee = 'authenticated' and privilege_type = 'UPDATE'
      order by 1
    `);
    expect(r.rows.map((l) => l.column_name)).toEqual(["revisado_em", "revisado_por_email", "status"]);
  });

  it("nenhuma policy é frouxa, e toda policy passa pelo portão de gestão", async () => {
    const r = await db.query(`
      select tablename, policyname, qual, with_check from pg_policies
      where schemaname = 'public'
        and tablename in ('acordos_prime_staging', 'acordos_prime_staging_criticas')
    `);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const p of r.rows) {
      const texto = `${p.qual ?? ""}${p.with_check ?? ""}`;
      expect(texto.replace(/[\s()]/g, "")).not.toBe("true");
      expect(texto).toContain("usuario_e_gestao");
    }
  });

  it("a view respeita a RLS de quem consulta (security_invoker)", async () => {
    const r = await db.query(`
      select array_to_string(c.reloptions, ',') as opcoes from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'acordos_prime_staging_atual'
    `);
    expect(r.rows[0].opcoes || "").toContain("security_invoker=true");
  });

  it("não há FK amarrando o staging a tabela financeira", async () => {
    const r = await db.query(`
      select c.conname from pg_constraint c
      join pg_class ct on ct.oid = c.conrelid
      join pg_class cf on cf.oid = c.confrelid
      where ct.relname in ('acordos_prime_staging', 'acordos_prime_staging_criticas')
        and c.contype = 'f'
        and cf.relname in ('acordos', 'acordos_titulos', 'parcelas', 'baixas_pagamento', 'pagamentos')
    `);
    expect(r.rows).toEqual([]);
  });
});

describe("staging de ACORDOS: teste de perfil, com os casos de produção", () => {
  it("roda 02_casos.sql inteiro — operador não lê nem escreve, gestão lê e revisa", async () => {
    // Os blocos `do $$` do arquivo levantam exceção quando um caso falha, então
    // `exec` sem erro É o resultado. Mesmo arquivo que o CI roda por psql.
    const db = new PGlite();
    await db.exec(AMBIENTE);
    await db.exec(PROPOSTA);
    await expect(db.exec(CASOS)).resolves.toBeDefined();
  }, 180000);
});

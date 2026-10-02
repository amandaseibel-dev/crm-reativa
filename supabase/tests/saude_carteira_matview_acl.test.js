// A MATVIEW DA SAUDE DA CARTEIRA NAO PODE SER LEGIVEL POR `authenticated`.
//
// O QUE ACONTECEU (producao, 02/10/2026).
//
// A migration 20261002120000 recria `mv_saude_carteira` -- `create or replace`
// nao adiciona coluna a materialized view. O schema `public` tem um
// ALTER DEFAULT PRIVILEGES que concede TUDO a `authenticated` em relacoes
// novas. A matview antiga nao tinha esse grant; a recriada herdou. Medido logo
// apos a aplicacao: a ACL voltou como
//   postgres | authenticated | service_role
// em vez de
//   postgres | service_role
//
// POR QUE ISSO IMPORTA. A tela le a carteira pelas RPCs SECURITY DEFINER, que
// aplicam `saude_carteira_escopo`: operador enxerga so a propria carteira. Com
// SELECT direto na matview, qualquer usuario autenticado le a carteira INTEIRA,
// de todos os operadores -- o escopo deixa de existir.
//
// Este arquivo prova as tres coisas, num PostgreSQL de verdade:
//   1. o perigo e REAL: sem o revoke, criar a matview ja entrega o privilegio;
//   2. a migration fecha;
//   3. o rollback tambem fecha -- ele recria a matview e herdaria o mesmo grant.
//
// Nao testa calculo, view, RPC nem regra de cobertura: nada disso muda aqui.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const MIGRATION = "supabase/migrations/20261002120000_saude_carteira_cobertura_10d.sql";
const ROLLBACK = "supabase/rollbacks/20261002120000_saude_carteira_cobertura_10d.rollback.sql";
const REVOKE = "revoke all on public.mv_saude_carteira from authenticated;";

const ler = (p) => readFileSync(p, "utf-8");

// Reproduz a situacao de producao: o papel `authenticated` e um default
// privilege em `public` que o contempla. E exatamente isso que faz um objeto
// novo nascer legivel sem ninguem ter escrito um grant.
async function bancoComoProducao() {
  const db = await PGlite.create();
  await db.exec(`
    create role authenticated;
    create role service_role;
    alter default privileges in schema public
      grant all on tables to authenticated, service_role;
  `);
  return db;
}

// Uma matview qualquer serve: o que esta sob teste e a ACL de uma matview
// RECEM-CRIADA em public, nao o conteudo da Saude da Carteira.
const CRIA_BASE = `
  create table base (id int primary key, v int);
  insert into base values (1, 10);
`;

// Criar a matview e um passo proprio porque o rollback faz isso DE NOVO: a
// tabela de apoio sobrevive, a matview nao.
const CRIA_MATVIEW = `
  create materialized view public.mv_saude_carteira as select * from base;
  create unique index ux_mv on public.mv_saude_carteira (id);
  grant select on public.mv_saude_carteira to service_role;
`;

const podeLer = async (db, papel) =>
  (await db.query(`select has_table_privilege($1, 'public.mv_saude_carteira', 'SELECT') ok`, [papel]))
    .rows[0].ok;

const acl = async (db) =>
  (await db.query(`
    select coalesce(array_to_string(c.relacl, ' | '), '(sem acl)') acl
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'mv_saude_carteira'`)).rows[0].acl;

describe("ACL da matview da Saúde da Carteira", () => {
  it("o perigo é real: sem o revoke, a matview recriada já nasce legível por authenticated", async () => {
    const db = await bancoComoProducao();
    await db.exec(CRIA_BASE);
    await db.exec(CRIA_MATVIEW);

    // Ninguem escreveu `grant ... to authenticated`. O default privilege fez.
    expect(await podeLer(db, "authenticated")).toBe(true);
    expect(await acl(db)).toContain("authenticated");
    await db.close();
  });

  it("depois da migration, authenticated NÃO tem privilégio direto na matview", async () => {
    const db = await bancoComoProducao();
    await db.exec(CRIA_BASE);
    await db.exec(CRIA_MATVIEW);
    await db.exec(REVOKE);

    expect(await podeLer(db, "authenticated")).toBe(false);
    // service_role continua lendo: as RPCs SECURITY DEFINER dependem disso.
    expect(await podeLer(db, "service_role")).toBe(true);
    expect(await acl(db)).not.toContain("authenticated=");
    await db.close();
  });

  it("depois do rollback, que também recria a matview, authenticated continua sem privilégio", async () => {
    const db = await bancoComoProducao();
    await db.exec(CRIA_BASE);
    // migration
    await db.exec(CRIA_MATVIEW);
    await db.exec(REVOKE);
    // rollback: derruba e recria -- e aqui que o grant voltaria
    await db.exec(`drop materialized view public.mv_saude_carteira;`);
    await db.exec(CRIA_MATVIEW);
    expect(await podeLer(db, "authenticated")).toBe(true); // voltou, como esperado
    await db.exec(REVOKE);

    expect(await podeLer(db, "authenticated")).toBe(false);
    expect(await podeLer(db, "service_role")).toBe(true);
    await db.close();
  });

  // Os testes acima provam o MECANISMO. Estes amarram o mecanismo aos arquivos
  // reais: sem isso, alguem removeria a linha e os testes de cima seguiriam
  // verdes, porque eles executam a constante, nao o arquivo.
  it("a migration contém o revoke, depois de criar a matview", async () => {
    const sql = ler(MIGRATION);
    expect(sql).toContain(REVOKE);
    expect(sql.indexOf("create materialized view public.mv_saude_carteira"))
      .toBeLessThan(sql.indexOf(REVOKE));
  });

  it("o rollback contém o revoke, depois de recriar a matview", async () => {
    const sql = ler(ROLLBACK);
    expect(sql).toContain(REVOKE);
    expect(sql.indexOf("create materialized view public.mv_saude_carteira"))
      .toBeLessThan(sql.indexOf(REVOKE));
  });

  it("nenhum dos dois arquivos concede nada a authenticated", async () => {
    for (const p of [MIGRATION, ROLLBACK]) {
      const sql = ler(p);
      expect(sql).not.toMatch(/grant[^;]*\bto\b[^;]*authenticated/i);
    }
  });
});

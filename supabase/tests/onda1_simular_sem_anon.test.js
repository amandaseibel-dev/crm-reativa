// ONDA 1 · a simulação não responde sem login — teste de PERMISSÃO.
//
// Roda a MIGRATION REAL
// (supabase/migrations/20261021190000_onda1_simular_fecha_anon.sql) e o
// ROLLBACK REAL num PostgreSQL real (PGlite).
//
// A correção é de PRIVILÉGIO, não de regra: a bancada é mínima de propósito.
// Entra o corpo EXATO de produção de `onda1_simular` (o mesmo arquivo da
// 20261021172255), os três papéis do Supabase e o que a função precisa para
// existir. O teste CHAMA como `anon` e mostra a porta aberta antes e fechada
// depois.
//
// A migration NÃO FOI APLICADA em banco nenhum por este arquivo: ele a executa
// num banco efêmero que morre no fim.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const BASE = ler("supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.sql");
const M3 = ler("supabase/tests/fixtures/nivelamento_m3_prod_20261021.sql");
const COMPL = ler("supabase/tests/fixtures/onda1_prod_20261021.sql");
const FUNCAO = ler("supabase/migrations/20261021172255_onda1_simular.sql");
const MIGRATION = ler("supabase/migrations/20261021190000_onda1_simular_fecha_anon.sql");
const ROLLBACK = ler("supabase/rollbacks/20261021190000_onda1_simular_fecha_anon.rollback.sql");

const ext = { unaccent, pg_trgm, uuid_ossp };
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;

const PAPEIS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
  end $$;
  grant usage on schema public to anon, authenticated, service_role;
`;

const podeExecutar = async (db, papel) =>
  Boolean((await q1(db, `select has_function_privilege($1, 'public.onda1_simular(jsonb)', 'execute') p`, [papel])).p);

const publicTemExecute = async (db) =>
  Boolean((await q1(db, `select exists (
      select 1 from information_schema.routine_privileges
       where routine_schema='public' and routine_name='onda1_simular'
         and grantee='PUBLIC' and privilege_type='EXECUTE') p`)).p);

const md5Corpo = async (db) =>
  (await q1(db, `select md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='onda1_simular'`)).m;

async function construir() {
  const db = new PGlite({ extensions: ext });
  await db.exec(PAPEIS);
  await db.exec(BASE);
  await db.exec(M3);
  await db.exec(COMPL);
  await db.exec(FUNCAO);
  return db;
}

let SEM, COM, MD5_PROD;
beforeAll(async () => {
  const a = await construir();
  MD5_PROD = await md5Corpo(a);
  SEM = await a.dumpDataDir();
  await a.close();
  const b = await construir();
  await b.exec(MIGRATION);
  COM = await b.dumpDataDir();
  await b.close();
});
const abrirSem = () => new PGlite({ loadDataDir: SEM, extensions: ext });
const abrirCom = () => new PGlite({ loadDataDir: COM, extensions: ext });

describe("a linha de base deixa a função alcançável sem login", () => {
  it("`anon` alcança — e é por herança de PUBLIC, não por grant próprio", async () => {
    const db = await abrirSem();
    expect(await publicTemExecute(db)).toBe(true);
    expect(await podeExecutar(db, "anon")).toBe(true);
    await db.close();
  });

  it("a chamada como `anon` chega na função e morre no PORTÃO INTERNO, não na porta", async () => {
    const db = await abrirSem();
    await db.query("set role anon");
    // 42501 do portao: o dado nunca vazou. O que existia era superficie.
    await expect(db.query("select public.onda1_simular('{}'::jsonb)")).rejects.toThrow(/permiss/i);
    await db.query("reset role");
    await db.close();
  });
});

describe("com a migration, sem login não alcança mais", () => {
  it("`anon` perde o alcance, e PUBLIC também", async () => {
    const db = await abrirCom();
    expect(await publicTemExecute(db)).toBe(false);
    expect(await podeExecutar(db, "anon")).toBe(false);
    await db.close();
  });

  it("a chamada como `anon` é recusada por PERMISSÃO DE EXECUÇÃO", async () => {
    const db = await abrirCom();
    await db.query("set role anon");
    await expect(db.query("select public.onda1_simular('{}'::jsonb)"))
      .rejects.toThrow(/permission denied|permissão|negad/i);
    await db.query("reset role");
    await db.close();
  });

  it("`authenticated` continua alcançando — a gestão não é derrubada", async () => {
    const db = await abrirCom();
    expect(await podeExecutar(db, "authenticated")).toBe(true);
    await db.close();
  });

  it("`service_role` continua alcançando — a Edge Function não quebra", async () => {
    const db = await abrirCom();
    expect(await podeExecutar(db, "service_role")).toBe(true);
    await db.close();
  });
});

describe("a correção mexe só em privilégio", () => {
  it("o corpo da função fica IDÊNTICO — lógica, parâmetros e resultado intactos", async () => {
    const db = await abrirCom();
    expect(await md5Corpo(db)).toBe(MD5_PROD);
    await db.close();
  });

  it("a assinatura e as propriedades não mudam", async () => {
    const f = async (db) => q1(db,
      `select pg_get_function_identity_arguments(p.oid) args, p.prosecdef, p.provolatile,
              obj_description(p.oid,'pg_proc') com
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='onda1_simular'`);
    const sem = await abrirSem(); const com = await abrirCom();
    expect(await f(com)).toEqual(await f(sem));
    await sem.close(); await com.close();
  });

  it("o arquivo não contém DDL de função/tabela/gatilho nem DML", () => {
    const exec = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toLowerCase();
    for (const proibido of [
      "create or replace function", "drop function", "create table", "alter table",
      "create trigger", "drop trigger", "insert into", "update ", "delete from", "truncate",
    ]) {
      expect(exec).not.toContain(proibido);
    }
  });

  it("NÃO revoga de `authenticated` — o erro que já foi cometido uma vez", () => {
    const exec = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toLowerCase();
    expect(exec).not.toMatch(/revoke[^;]*from[^;]*authenticated/);
    expect(exec).toMatch(/revoke[^;]*from public/);
    expect(exec).toMatch(/revoke[^;]*from anon/);
  });

  it("NENHUMA outra função teve privilégio alterado", async () => {
    const acl = async (db) => qn(db,
      `select p.proname, coalesce(array_to_string(p.proacl,'|'),'(default)') acl
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','internal') and p.proname <> 'onda1_simular'
        order by p.proname`);
    const sem = await abrirSem(); const com = await abrirCom();
    expect(await acl(com)).toEqual(await acl(sem));
    await sem.close(); await com.close();
  });
});

describe("idempotência e rollback", () => {
  it("aplicar duas vezes não muda nada", async () => {
    const db = await abrirCom();
    const antes = { pub: await publicTemExecute(db), anon: await podeExecutar(db, "anon"),
                    auth: await podeExecutar(db, "authenticated"), md5: await md5Corpo(db) };
    await db.exec(MIGRATION);
    expect({ pub: await publicTemExecute(db), anon: await podeExecutar(db, "anon"),
             auth: await podeExecutar(db, "authenticated"), md5: await md5Corpo(db) }).toEqual(antes);
    await db.close();
  });

  it("o rollback reabre para PUBLIC e o corpo continua intacto", async () => {
    const db = await abrirCom();
    await db.exec(ROLLBACK);
    expect(await publicTemExecute(db)).toBe(true);
    expect(await podeExecutar(db, "anon")).toBe(true);
    expect(await md5Corpo(db)).toBe(MD5_PROD);
    await db.close();
  });
});

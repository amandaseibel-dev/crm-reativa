// USO DE TELAS — WHITELIST DE ROTAS (migration 20261119000000).
//
// Bancada PGlite (Postgres real, sem dados de produção):
//   • carrega a migration base (20261118000000_uso_telas.sql)
//   • carrega a migration whitelist (20261119000000_uso_telas_whitelist.sql)
//   • stubs mínimos de auth.jwt() e usuario_e_gestao() — mesmo padrão de
//     conferencia_pagamento_na_ficha.test.js
//
// O que prova:
//   T1  rota cadastrada (/painel-carteira) grava 1 acesso e incrementa em nova chamada
//   T2  rota bem formatada mas inexistente (/rota-inventada) não grava nenhuma linha
//   T3  rota mal formatada (/rota inválida com espaço) também não grava
//   T4  chamada sem email no JWT retorna silenciosamente sem gravar
//   T5  ACL da RPC: authenticated tem EXECUTE, anon não tem
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const ler = (p) => readFileSync(resolve(p), "utf8");
const MIG_BASE      = ler("supabase/migrations/20261118000000_uso_telas.sql");
const MIG_WHITELIST = ler("supabase/migrations/20261119000000_uso_telas_whitelist.sql");

// Stubs de auth e gestão — sem eles a migration falha ao criar a RPC.
const STUBS = `
  create schema if not exists auth;
  create or replace function auth.jwt() returns jsonb language sql stable
    as $$ select jsonb_build_object('email',
         coalesce(current_setting('teste.email', true), 'operador@reativa.com')) $$;
  create or replace function auth.role() returns text language sql stable
    as $$ select 'authenticated' $$;
  create or replace function public.usuario_e_gestao() returns boolean language sql stable
    as $$ select coalesce(current_setting('teste.gestao', true), 'off') = 'on' $$;
`;

// Papéis mínimos exigidos pelas migrations (revoke/grant referencia esses nomes).
const PAPEIS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role; end if;
  end $$;
`;

let BASE;
beforeAll(async () => {
  const db = new PGlite();
  await db.exec(PAPEIS);
  await db.exec(STUBS);
  await db.exec(MIG_BASE);
  await db.exec(MIG_WHITELIST);
  BASE = await db.dumpDataDir();
  await db.close();
});

const novo = async (email = "operador@reativa.com") => {
  const db = new PGlite({ loadDataDir: BASE });
  if (email) await db.exec(`set teste.email = '${email}'`);
  return db;
};

const contar = async (db, rota) =>
  (await db.query(
    "select coalesce(sum(acessos),0)::int total from public.uso_telas where rota = $1",
    [rota]
  )).rows[0].total;

const registrar = async (db, rota) =>
  db.query("select public.registrar_acesso_tela($1)", [rota]);

describe("uso_telas whitelist", () => {
  it("T1 — rota cadastrada grava e incrementa", async () => {
    const db = await novo("alice@reativa.com");

    await registrar(db, "/painel-carteira");
    expect(await contar(db, "/painel-carteira")).toBe(1);

    await registrar(db, "/painel-carteira");
    expect(await contar(db, "/painel-carteira")).toBe(2);

    await db.close();
  });

  it("T2 — rota bem formatada mas inexistente não grava nenhuma linha", async () => {
    const db = await novo("bob@reativa.com");

    await registrar(db, "/rota-inventada");

    const total = (await db.query(
      "select count(*)::int n from public.uso_telas where rota = '/rota-inventada'"
    )).rows[0].n;
    expect(total).toBe(0);

    await db.close();
  });

  it("T3 — rota mal formatada (espaço) também não grava", async () => {
    const db = await novo("carol@reativa.com");

    await registrar(db, "/rota invalida com espaco");

    const total = (await db.query(
      "select count(*)::int n from public.uso_telas"
    )).rows[0].n;
    expect(total).toBe(0);

    await db.close();
  });

  it("T4 — chamada sem email no JWT não grava", async () => {
    const db = await novo(null); // null → current_setting devolve '' → nullif → null
    // substitui stub para devolver email vazio
    await db.exec(`
      create or replace function auth.jwt() returns jsonb language sql stable
        as $$ select jsonb_build_object('email', '') $$;
    `);

    await registrar(db, "/painel-carteira");

    const total = (await db.query(
      "select count(*)::int n from public.uso_telas"
    )).rows[0].n;
    expect(total).toBe(0);

    await db.close();
  });

  it("T5 — ACL: authenticated executa, anon não executa", async () => {
    const db = new PGlite({ loadDataDir: BASE });
    const r = (await db.query(`
      select
        has_function_privilege('authenticated', 'public.registrar_acesso_tela(text)', 'EXECUTE') auth_ok,
        has_function_privilege('anon',          'public.registrar_acesso_tela(text)', 'EXECUTE') anon_ok
    `)).rows[0];
    expect(r.auth_ok).toBe(true);
    expect(r.anon_ok).toBe(false);
    await db.close();
  });
});

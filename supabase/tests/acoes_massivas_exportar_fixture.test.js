// Prende a fixture de producao de acoes_massivas_exportar ao MD5 declarado (c9cc7498...).
// Carrega o arquivo versionado em PGlite (Postgres real em WASM) e compara pg_get_functiondef.
// Nao acessa producao. Nao reaplica nada fora do banco descartavel de teste.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(resolve(AQUI, "fixtures/acoes_massivas_exportar/prod_20261115_definicao_vigente.sql"), "utf8");
const MD5_DECLARADO = "c9cc7498d16ca250e85c4727c8bb05bd";
const TAMANHO = 6426;

describe("fixture de producao de acoes_massivas_exportar", () => {
  it("o arquivo versionado reproduz o MD5 e o tamanho de producao", async () => {
    const db = new PGlite();
    await db.exec(`create schema if not exists auth;
      create or replace function auth.role() returns text language sql as $$ select 'x' $$;
      create or replace function auth.jwt() returns jsonb language sql as $$ select null::jsonb $$;
      create or replace function auth.email() returns text language sql as $$ select null::text $$;`);
    await db.exec(FIXTURE);
    const r = await db.query("select md5(pg_get_functiondef(p.oid)) m, length(pg_get_functiondef(p.oid)) l from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_exportar'");
    expect(r.rows[0].m).toBe(MD5_DECLARADO);
    expect(r.rows[0].l).toBe(TAMANHO);
  }, 60000);
});

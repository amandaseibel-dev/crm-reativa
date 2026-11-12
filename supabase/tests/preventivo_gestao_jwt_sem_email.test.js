// REGRESSÃO: JWT de usuário SEM e-mail (login anônimo) não passa em
// preventivo_e_gestao(). Antes, `current_user` (= dono, por SECURITY DEFINER)
// liberava qualquer chamador sem claim de e-mail. NENHUM DADO REAL.
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GESTAO = "amanda.seibel@aelbra.com.br";
const DIRETORIA = ["angela.ferreira@aelbra.com.br", "gustavo.ene@aelbra.com.br"];
const ADM = "cobranca07@aelbra.com.br";
const migs = (filtro) => readdirSync(resolve(RAIZ, "supabase/migrations"))
  .filter((f) => /preventivo/.test(f) && f.endsWith(".sql") && filtro(f)).sort()
  .map((f) => readFileSync(resolve(RAIZ, "supabase/migrations", f), "utf8"));

let db;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table public._jwt (claims jsonb);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select (select claims from public._jwt limit 1) $$;
    create table public.usuarios (email text, ativo boolean default true);
    insert into public.usuarios values ('${GESTAO}', true), ('${ADM}', true),
      ('${DIRETORIA[0]}', true), ('${DIRETORIA[1]}', true);
    insert into public._jwt values (null);
  `);
  for (const m of migs(() => true)) await db.exec(m);
});

const com = async (claims) => {
  await db.exec(`update public._jwt set claims = ${claims ? `'${JSON.stringify(claims)}'::jsonb` : "null"}`);
  return (await db.query(`select public.preventivo_e_gestao() as ok`)).rows[0].ok;
};

describe("preventivo_e_gestao() — JWT sem e-mail", () => {
  it("authenticated sem e-mail (login anônimo) é BARRADO", async () => {
    expect(await com({ role: "authenticated" })).toBe(false);
    expect(await com({ role: "authenticated", is_anonymous: true })).toBe(false);
  });
  it("role desconhecida sem e-mail é barrada", async () => {
    expect(await com({ role: "anon" })).toBe(false);
  });
  it("chamada interna continua: service_role e ausência de JWT (cron)", async () => {
    expect(await com({ role: "service_role" })).toBe(true);
    expect(await com(null)).toBe(true);
  });
  it("gestão passa; Amanda ADM e e-mail desconhecido não", async () => {
    expect(await com({ role: "authenticated", email: GESTAO })).toBe(true);
    expect(await com({ role: "authenticated", email: ADM })).toBe(false);
    expect(await com({ role: "authenticated", email: "x@y.com" })).toBe(false);
  });
  it("a diretoria liberada em 08/10 continua passando (não regride o acesso vivo)", async () => {
    for (const email of DIRETORIA) expect(await com({ role: "authenticated", email })).toBe(true);
  });
  it("gestão desativada não passa", async () => {
    await db.exec(`update public.usuarios set ativo = false where email = '${GESTAO}'`);
    expect(await com({ role: "authenticated", email: GESTAO })).toBe(false);
    await db.exec(`update public.usuarios set ativo = true where email = '${GESTAO}'`);
  });
  it("as RPCs financeiras recusam o authenticated sem e-mail", async () => {
    await db.exec(`update public._jwt set claims = '{"role":"authenticated"}'::jsonb`);
    for (const sql of [
      "select public.preventivo_visao_geral(null)",
      "select public.preventivo_aluno_historico('2026000001')",
      "select public.preventivo_remessa_mudancas(gen_random_uuid())",
    ]) await expect(db.query(sql)).rejects.toThrow(/acesso restrito à gestão/);
  });
  // O papel REAL da sessão vale mesmo quando o JWT some ou vem incompleto.
  describe("papel real da sessão", () => {
    const como = async (papel, claims) => {
      await db.exec(`update public._jwt set claims = ${claims ? `'${JSON.stringify(claims)}'::jsonb` : "null"}`);
      await db.exec(`set role ${papel}`);
      try { return (await db.query(`select public.preventivo_e_gestao() as ok`)).rows[0].ok; }
      finally { await db.exec(`reset role`); }
    };
    it("authenticated com JWT AUSENTE ou SEM claim role é barrado", async () => {
      expect(await como("authenticated", null)).toBe(false);
      expect(await como("authenticated", {})).toBe(false);
      expect(await como("authenticated", { sub: "u1" })).toBe(false);
    });
    it("authenticated não se passa por service_role forjando o claim", async () => {
      expect(await como("authenticated", { role: "service_role" })).toBe(false);
    });
    it("service_role (processo interno) segue passando", async () => {
      expect(await como("service_role", { role: "service_role" })).toBe(true);
    });
    it("cron/postgres sem JWT segue passando", async () => {
      await db.exec(`reset role`);
      expect(await com(null)).toBe(true);
    });
  });

  it("o grant da função é preservado (anon sem EXECUTE)", async () => {
    const r = await db.query(`select has_function_privilege('anon','public.preventivo_e_gestao()','execute') a,
      has_function_privilege('authenticated','public.preventivo_e_gestao()','execute') b`);
    expect(r.rows[0]).toEqual({ a: false, b: true });
  });
});

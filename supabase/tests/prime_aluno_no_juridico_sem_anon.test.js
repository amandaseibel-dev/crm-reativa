// P1 · SITUAÇÃO JURÍDICA POR CPF NÃO RESPONDE SEM LOGIN — teste de permissão.
//
// Roda a MIGRATION REAL
// (supabase/migrations/20261020184623_prime_aluno_no_juridico_fecha_anon.sql) e o
// ROLLBACK REAL num PostgreSQL real (PGlite).
//
// A bancada é mínima de propósito: a correção é de PRIVILÉGIO, não de regra.
// Entram só o que a função precisa para existir e rodar — a tabela
// `prime_portador_membro`, um `prime_portador_snapshot_estado` de apoio, os três
// papéis do Supabase (`anon`, `authenticated`, `service_role`) e o corpo EXATO
// de produção de `prime_aluno_no_juridico`, com md5(prosrc)
// 7066bc7660854bf34ac45b95b032f65b.
//
// O teste não é só de flag de privilégio: ele CHAMA a função como `anon` e
// mostra a exposição acontecendo antes, e sendo recusada depois.
//
// NENHUM DADO REAL: o CPF é inventado (11 dígitos sintéticos).
//
// A migration NÃO FOI APLICADA em banco nenhum. Este teste é a única coisa que a
// executa, num banco efêmero que morre no fim.
globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 60000, hookTimeout: 120000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const MIGRATION = ler("supabase/migrations/20261020184623_prime_aluno_no_juridico_fecha_anon.sql");
const ROLLBACK = ler("supabase/rollbacks/20261020184623_prime_aluno_no_juridico_fecha_anon.rollback.sql");

const MD5_PROD = "7066bc7660854bf34ac45b95b032f65b";
const CPF_NO_JURIDICO = "98765432100";
const CPF_FORA = "12345678909";

const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];

// Corpo EXATO de produção em 20/10/2026 (pg_get_functiondef).
const FUNCAO_PROD = `
create table if not exists public.prime_portador_membro (
  cpf text, portador integer, coletado_em timestamptz default now()
);
insert into public.prime_portador_membro (cpf, portador) values ('${CPF_NO_JURIDICO}', 202);

-- Apoio: a função de produção chama isto com UM argumento.
create or replace function public.prime_portador_snapshot_estado(
  p_portador integer, p_max_idade_horas integer default 24)
returns jsonb language sql stable as $apoio$
  select jsonb_build_object('valido', true, 'portador', p_portador);
$apoio$;

CREATE OR REPLACE FUNCTION public.prime_aluno_no_juridico(p_cpf text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cpf text := lpad(regexp_replace(coalesce(p_cpf,''), '\\D', '', 'g'), 11, '0');
  v_estado jsonb;
begin
  if length(v_cpf) <> 11 or v_cpf !~ '^[0-9]{11}$' or v_cpf = '00000000000' then
    return 'INDETERMINADO';
  end if;

  if exists (
    select 1 from public.prime_portador_membro m
     where m.portador = 202
       and lpad(regexp_replace(coalesce(m.cpf,''), '\\D', '', 'g'), 11, '0') = v_cpf
  ) then
    return 'SIM';
  end if;

  v_estado := public.prime_portador_snapshot_estado(202);
  if not coalesce((v_estado->>'valido')::boolean, false) then
    return 'INDETERMINADO';
  end if;

  return 'NAO';
end;
$function$;
`;

const PAPEIS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
  end $$;
  grant usage on schema public to anon, authenticated, service_role;
`;

const podeExecutar = async (db, papel) =>
  Boolean((await q1(db,
    `select has_function_privilege($1, 'public.prime_aluno_no_juridico(text)', 'execute') p`,
    [papel])).p);

const publicTemExecute = async (db) =>
  Boolean((await q1(db,
    `select exists (
       select 1 from information_schema.routine_privileges
        where routine_schema='public' and routine_name='prime_aluno_no_juridico'
          and grantee='PUBLIC' and privilege_type='EXECUTE') p`)).p);

const md5Corpo = async (db) =>
  (await q1(db, `select md5(p.prosrc) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='prime_aluno_no_juridico'`)).m;

const comoPapel = async (db, papel, sql, p = []) => {
  await db.query(`set role ${papel}`);
  try { return await q1(db, sql, p); } finally { await db.query("reset role"); }
};

let SEM, COM;

async function construir() {
  const db = new PGlite();
  await db.exec(PAPEIS);
  await db.exec(FUNCAO_PROD);
  return db;
}

beforeAll(async () => {
  const b1 = await construir();
  SEM = await b1.dumpDataDir();
  await b1.close();
  const b2 = await construir();
  await b2.exec(MIGRATION);
  COM = await b2.dumpDataDir();
  await b2.close();
});

const abrirSem = () => new PGlite({ loadDataDir: SEM });
const abrirCom = () => new PGlite({ loadDataDir: COM });

describe("a bancada reproduz a função de produção", () => {
  it("o corpo é o de produção, por md5", async () => {
    const db = await abrirSem();
    expect(await md5Corpo(db)).toBe(MD5_PROD);
    await db.close();
  });
});

describe("a linha de base expõe o dado sem login", () => {
  it("`anon` alcança a função — e é por herança de PUBLIC, não por grant próprio", async () => {
    const db = await abrirSem();
    expect(await publicTemExecute(db)).toBe(true);
    expect(await podeExecutar(db, "anon")).toBe(true);
    await db.close();
  });

  it("e a chamada como `anon` RESPONDE que o CPF está no jurídico", async () => {
    const db = await abrirSem();
    const r = await comoPapel(db, "anon",
      "select public.prime_aluno_no_juridico($1) v", [CPF_NO_JURIDICO]);
    expect(r.v).toBe("SIM"); // a exposição, acontecendo
    await db.close();
  });
});

describe("com a migration, sem login não responde mais", () => {
  it("`anon` deixa de alcançar, e PUBLIC também", async () => {
    const db = await abrirCom();
    expect(await publicTemExecute(db)).toBe(false);
    expect(await podeExecutar(db, "anon")).toBe(false);
    await db.close();
  });

  it("a chamada como `anon` é RECUSADA", async () => {
    const db = await abrirCom();
    await db.query("set role anon");
    await expect(
      db.query("select public.prime_aluno_no_juridico($1)", [CPF_NO_JURIDICO])
    ).rejects.toThrow(/permission denied|permissão|negad/i);
    await db.query("reset role");
    await db.close();
  });

  it("`authenticated` continua consultando — a tela não quebra", async () => {
    const db = await abrirCom();
    expect(await podeExecutar(db, "authenticated")).toBe(true);
    const r = await comoPapel(db, "authenticated",
      "select public.prime_aluno_no_juridico($1) v", [CPF_NO_JURIDICO]);
    expect(r.v).toBe("SIM");
    await db.close();
  });

  it("`service_role` continua consultando — Edge Function não quebra", async () => {
    const db = await abrirCom();
    expect(await podeExecutar(db, "service_role")).toBe(true);
    const r = await comoPapel(db, "service_role",
      "select public.prime_aluno_no_juridico($1) v", [CPF_FORA]);
    expect(r.v).toBe("NAO");
    await db.close();
  });

  it("a resposta para quem tem acesso é a MESMA de antes", async () => {
    const sem = await abrirSem();
    const com = await abrirCom();
    for (const cpf of [CPF_NO_JURIDICO, CPF_FORA, "00000000000", "abc"]) {
      const a = await comoPapel(sem, "authenticated", "select public.prime_aluno_no_juridico($1) v", [cpf]);
      const b = await comoPapel(com, "authenticated", "select public.prime_aluno_no_juridico($1) v", [cpf]);
      expect(b.v).toBe(a.v);
    }
    await sem.close();
    await com.close();
  });
});

describe("a migration mexe só em privilégio", () => {
  it("o corpo da função fica idêntico ao de produção", async () => {
    const db = await abrirCom();
    expect(await md5Corpo(db)).toBe(MD5_PROD);
    await db.close();
  });

  it("o arquivo não contém DDL de função, tabela, gatilho nem DML", async () => {
    const m = MIGRATION.toLowerCase();
    for (const proibido of [
      "create or replace function", "drop function", "create table", "alter table",
      "create trigger", "drop trigger", "insert into", "update ", "delete from", "truncate",
    ]) {
      expect(m.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toContain(proibido);
    }
  });

  it("NÃO revoga de `authenticated` — o erro que já foi cometido uma vez", async () => {
    const executaveis = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toLowerCase();
    expect(executaveis).not.toMatch(/revoke[^;]*from[^;]*authenticated/);
    expect(executaveis).toMatch(/revoke[^;]*from public/);
    expect(executaveis).toMatch(/revoke[^;]*from anon/);
  });

  it("nenhuma outra função teve privilégio alterado", async () => {
    const sem = await abrirSem();
    const com = await abrirCom();
    const acl = async (db) => (await db.query(
      `select p.proname, coalesce(array_to_string(p.proacl, '|'), '(default)') acl
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname <> 'prime_aluno_no_juridico'
        order by p.proname`)).rows;
    expect(await acl(com)).toEqual(await acl(sem));
    await sem.close();
    await com.close();
  });
});

describe("o rollback devolve o estado anterior", () => {
  it("reabre para PUBLIC e `anon` volta a responder", async () => {
    const db = await abrirCom();
    await db.exec(ROLLBACK);
    expect(await publicTemExecute(db)).toBe(true);
    expect(await podeExecutar(db, "anon")).toBe(true);
    const r = await comoPapel(db, "anon",
      "select public.prime_aluno_no_juridico($1) v", [CPF_NO_JURIDICO]);
    expect(r.v).toBe("SIM");
    await db.close();
  });

  it("e o corpo continua intacto depois de ir e voltar", async () => {
    const db = await abrirCom();
    await db.exec(ROLLBACK);
    expect(await md5Corpo(db)).toBe(MD5_PROD);
    await db.close();
  });
});

describe("a migration é idempotente", () => {
  it("aplicar duas vezes não muda nada", async () => {
    const db = await abrirCom();
    const antes = { pub: await publicTemExecute(db), anon: await podeExecutar(db, "anon"),
                    auth: await podeExecutar(db, "authenticated"), md5: await md5Corpo(db) };
    await db.exec(MIGRATION);
    expect({ pub: await publicTemExecute(db), anon: await podeExecutar(db, "anon"),
             auth: await podeExecutar(db, "authenticated"), md5: await md5Corpo(db) }).toEqual(antes);
    await db.close();
  });
});

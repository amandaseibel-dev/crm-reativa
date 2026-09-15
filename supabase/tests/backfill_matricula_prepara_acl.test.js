// PREPARATORIA DA ACL DA STAGE -- 20260915135959.
//
// O QUE ESTE ARQUIVO PROVA, e por que ele precisa de um Postgres de verdade:
// a 20260915140000 ja esta no `main` e e imutavel, e sozinha ela ABORTA por
// causa das DEFAULT PRIVILEGES do schema `public`, que dao tudo a `anon`,
// `authenticated` e `service_role` em toda tabela nova. Isso e invisivel num
// teste de texto -- so aparece executando.
//
// A bancada REPRODUZ essas default privileges de proposito, porque foi a
// ausencia delas no PGlite que deixou o defeito passar da primeira vez. Esta e
// a segunda vez nesta frente que a diferenca entre PGlite e Supabase aparece;
// aqui ela esta simulada explicitamente, e e isso que da valor ao teste.
//
// NENHUM DADO REAL: nenhuma linha e inserida em tabela nenhuma.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGS = resolve(AQUI, "..", "migrations");
const PREP = resolve(MIGS, "20260915135959_prepara_acl_da_stage_do_backfill.sql");
const MOTOR = resolve(MIGS, "20260915140000_backfill_matricula_prime_motor.sql");
const sqlPrep = readFileSync(PREP, "utf8");
const sqlMotor = readFileSync(MOTOR, "utf8");

const PAPEIS = ["anon", "authenticated", "service_role"];
const PRIVS = ["INSERT", "SELECT", "UPDATE", "DELETE"];

/** Bancada com as DEFAULT PRIVILEGES do Supabase reproduzidas. */
async function bancada({ comDefaults = true } = {}) {
  const db = await PGlite.create();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.pagamentos (id uuid primary key, numero_parcela_completo text,
      matricula text, tipo_pagamento text);`);
  if (comDefaults) {
    await db.exec(
      `alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
  }
  db.acl = async (papel, tabela) => {
    const r = {};
    for (const p of PRIVS) {
      const v = await db.query(`select has_table_privilege($1,$2,$3) x`, [papel, `public.${tabela}`, p]);
      r[p] = v.rows[0].x;
    }
    return r;
  };
  /** colunas, tipos, not null, default e chave primaria -- o schema funcional */
  db.schemaDaStage = async () => {
    const cols = await db.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema='public' and table_name='backfill_matricula_stage'
        order by ordinal_position`);
    const pk = await db.query(
      `select string_agg(a.attname, ',' order by k.ord) chave
         from pg_constraint c
         join lateral unnest(c.conkey) with ordinality k(att, ord) on true
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att
        where c.conrelid = 'public.backfill_matricula_stage'::regclass and c.contype = 'p'`);
    return JSON.stringify({ cols: cols.rows, pk: pk.rows[0].chave });
  };
  return db;
}

describe("1. sozinha, a 20260915140000 aborta", () => {
  it("aborta citando o privilegio a mais", async () => {
    const db = await bancada();
    await expect(db.exec(sqlMotor)).rejects.toThrow(/service_role ganhou mais que INSERT na stage/);
  }, 60000);
  it("e nao deixa nada para tras -- transacional", async () => {
    const db = await bancada();
    await db.exec(sqlMotor).catch(() => {});
    const t = await db.query(`select to_regclass('public.backfill_matricula_stage') x`);
    expect(t.rows[0].x).toBeNull();
  }, 60000);
  it("sem as default privileges ela aplicaria -- e essa a causa", async () => {
    const db = await bancada({ comDefaults: false });
    await expect(db.exec(sqlMotor)).resolves.not.toThrow();
  }, 60000);
});

describe("2. preparatoria + 140000 aplica", () => {
  it("as duas, na ordem, aplicam sem erro", async () => {
    const db = await bancada();
    await expect(db.exec(sqlPrep)).resolves.not.toThrow();
    await expect(db.exec(sqlMotor)).resolves.not.toThrow();
  }, 60000);
  it("os quatro objetos existem ao fim", async () => {
    const db = await bancada();
    await db.exec(sqlPrep); await db.exec(sqlMotor);
    for (const t of ["backfill_matricula_stage", "backfill_matricula_lotes",
                     "backfill_matricula_origem"]) {
      const v = await db.query(`select to_regclass($1) x`, [`public.${t}`]);
      expect(v.rows[0].x, t).not.toBeNull();
    }
    const f = await db.query(`select pg_get_function_identity_arguments(p.oid) a
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='backfill_matricula_aplicar'`);
    expect(f.rows[0].a).toBe("p_lote text, p_hash text, p_esperado integer");
  }, 60000);
});

describe("3. o schema funcional e o MESMO -- so a ACL muda", () => {
  it("prep+140000 com defaults == 140000 sozinha sem defaults", async () => {
    const referencia = await bancada({ comDefaults: false });
    await referencia.exec(sqlMotor);
    const esperado = await referencia.schemaDaStage();

    const real = await bancada();
    await real.exec(sqlPrep); await real.exec(sqlMotor);
    const obtido = await real.schemaDaStage();

    expect(obtido).toBe(esperado);
  }, 90000);
  it("e a chave primaria e (lote, pagamento_id) nos dois caminhos", async () => {
    const db = await bancada();
    await db.exec(sqlPrep); await db.exec(sqlMotor);
    expect(await db.schemaDaStage()).toMatch(/"pk":"lote,pagamento_id"/);
  }, 60000);
  it("o CREATE TABLE da preparatoria e copia exata do da 140000", () => {
    const recorta = (s) => {
      const i = s.indexOf("create table if not exists public.backfill_matricula_stage");
      return s.slice(i, s.indexOf("\n);", i) + 3);
    };
    expect(recorta(sqlPrep)).toBe(recorta(sqlMotor));
  });
});

describe("4. ACL final, medida", () => {
  it("service_role: INSERT sim, SELECT/UPDATE/DELETE nao", async () => {
    const db = await bancada();
    await db.exec(sqlPrep); await db.exec(sqlMotor);
    expect(await db.acl("service_role", "backfill_matricula_stage"))
      .toEqual({ INSERT: true, SELECT: false, UPDATE: false, DELETE: false });
  }, 60000);
  it("anon e authenticated: nenhum acesso a nenhuma das tres tabelas", async () => {
    const db = await bancada();
    await db.exec(sqlPrep); await db.exec(sqlMotor);
    for (const papel of ["anon", "authenticated"]) {
      for (const t of ["backfill_matricula_stage", "backfill_matricula_lotes",
                       "backfill_matricula_origem"]) {
        expect(await db.acl(papel, t), `${papel} em ${t}`)
          .toEqual({ INSERT: false, SELECT: false, UPDATE: false, DELETE: false });
      }
    }
  }, 60000);
  it("service_role nao alcanca a trilha", async () => {
    const db = await bancada();
    await db.exec(sqlPrep); await db.exec(sqlMotor);
    for (const t of ["backfill_matricula_lotes", "backfill_matricula_origem"]) {
      expect(await db.acl("service_role", t), t)
        .toEqual({ INSERT: false, SELECT: false, UPDATE: false, DELETE: false });
    }
  }, 60000);
  it("service_role continua sem EXECUTE no motor", async () => {
    const db = await bancada();
    await db.exec(sqlPrep); await db.exec(sqlMotor);
    for (const papel of [...PAPEIS, "public"]) {
      const v = await db.query(`select has_function_privilege($1,
        'public.backfill_matricula_aplicar(text, text, integer)','EXECUTE') x`, [papel]);
      expect(v.rows[0].x, papel).toBe(false);
    }
  }, 60000);
  it("RLS ligada e sem policy", async () => {
    const db = await bancada();
    await db.exec(sqlPrep); await db.exec(sqlMotor);
    const r = await db.query(`select relrowsecurity from pg_class
      where oid='public.backfill_matricula_stage'::regclass`);
    expect(r.rows[0].relrowsecurity).toBe(true);
    const p = await db.query(`select count(*) c from pg_policies
      where schemaname='public' and tablename like 'backfill_matricula%'`);
    expect(Number(p.rows[0].c)).toBe(0);
  }, 60000);
});

describe("5. a preparatoria SOZINHA nao concede nada", () => {
  it("nenhum dos tres papeis ganha privilegio algum", async () => {
    const db = await bancada();
    await db.exec(sqlPrep);
    for (const papel of PAPEIS) {
      expect(await db.acl(papel, "backfill_matricula_stage"), papel)
        .toEqual({ INSERT: false, SELECT: false, UPDATE: false, DELETE: false });
    }
  }, 60000);
  it("ela nao cria funcao, trilha nem indice", async () => {
    const db = await bancada();
    await db.exec(sqlPrep);
    for (const t of ["backfill_matricula_lotes", "backfill_matricula_origem"]) {
      const v = await db.query(`select to_regclass($1) x`, [`public.${t}`]);
      expect(v.rows[0].x, t).toBeNull();
    }
    const f = await db.query(`select count(*) c from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='backfill_matricula_aplicar'`);
    expect(Number(f.rows[0].c)).toBe(0);
  }, 60000);
});

describe("6. escopo: nada fora da stage e tocado", () => {
  it("nao mexe em DEFAULT PRIVILEGES", () => {
    expect(sqlPrep).not.toMatch(/alter\s+default\s+privileges/i);
  });
  it("nao nomeia nenhuma outra tabela em comando algum", () => {
    const codigo = sqlPrep.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(codigo).not.toMatch(/\bpublic\.(pagamentos|acordos|parcelas|acordos_titulos|fluxo_pagamentos_config)\b/);
    expect(codigo).not.toMatch(/backfill_matricula_(lotes|origem)/);
  });
  it("nao cria funcao, trigger, policy nem role", () => {
    const codigo = sqlPrep.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(codigo).not.toMatch(/create (or replace )?(function|trigger|policy|role)/i);
  });
  it("nao concede INSERT -- quem concede e a 140000, que e quem prova", () => {
    const codigo = sqlPrep.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(codigo).not.toMatch(/\bgrant\b/i);
  });
  it("as demais tabelas do projeto mantem a ACL que tinham", async () => {
    const db = await bancada();
    const antes = await db.acl("service_role", "pagamentos");
    await db.exec(sqlPrep); await db.exec(sqlMotor);
    expect(await db.acl("service_role", "pagamentos")).toEqual(antes);
  }, 60000);
  it("as DEFAULT PRIVILEGES do schema continuam como estavam", async () => {
    const db = await bancada();
    const q = `select coalesce(string_agg(array_to_string(defaclacl,' '),' | '),'') a
                 from pg_default_acl d join pg_namespace n on n.oid=d.defaclnamespace
                where n.nspname='public'`;
    const antes = (await db.query(q)).rows[0].a;
    await db.exec(sqlPrep); await db.exec(sqlMotor);
    expect((await db.query(q)).rows[0].a).toBe(antes);
  }, 60000);
  it("nenhuma linha e inserida em tabela nenhuma", () => {
    const codigo = sqlPrep.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(codigo).not.toMatch(/\binsert\s+into\b|\bupdate\s+public\.|\bdelete\s+from\b/i);
  });
});

describe("7. ordenacao", () => {
  it("a preparatoria ordena antes da 140000", () => {
    expect("20260915135959" < "20260915140000").toBe(true);
  });
  it("o nome segue o padrao de 14 digitos com descricao", () => {
    expect("20260915135959_prepara_acl_da_stage_do_backfill.sql")
      .toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });
});

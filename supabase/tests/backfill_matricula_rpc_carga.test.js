// RPC DE CARGA DA STAGE -- 20260915170000.
//
// POR QUE ESTA MIGRATION EXISTE, e por que o teste precisa de Postgres de
// verdade: o smoke sintetico em producao reprovou com 42501 porque o PostgREST
// 14.5 envolve todo INSERT num CTE e faz SELECT dele. A porta de entrada
// deixou de ser a tabela e passou a ser uma funcao SECURITY DEFINER.
//
// PGLITE E POSTGRES DE VERDADE E NAO SUBSTITUI O SUPABASE. Aqui nao ha
// PostgREST: o que se prova e o comportamento da FUNCAO sob os papeis reais
// (`set role service_role` reproduz o que o PostgREST faz com `SET LOCAL
// ROLE`). O salto HTTP continua sendo provado so em producao.
//
// NENHUM DADO REAL. Todo UUID, matricula, boleto e arquivo aqui e inventado.
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGS = resolve(AQUI, "..", "migrations");
const sqlPrep = readFileSync(resolve(MIGS, "20260915135959_prepara_acl_da_stage_do_backfill.sql"), "utf8");
const sqlMotor = readFileSync(resolve(MIGS, "20260915140000_backfill_matricula_prime_motor.sql"), "utf8");
const sqlRpc = readFileSync(resolve(MIGS, "20260915170000_rpc_de_carga_da_stage_backfill.sql"), "utf8");
// SO O CORPO DA FUNCAO, sem comentarios. O bloco DO $prova$ da migration cita
// `pagamentos`, `execute` e `do update` de proposito -- para PROIBI-los -- e
// comparar contra o arquivo inteiro faria a assercao brigar com a propria prova.
const corpoRpc = (() => {
  const i = sqlRpc.indexOf("$fn$");
  return sqlRpc.slice(i + 4, sqlRpc.indexOf("$fn$", i + 4));
})();
const codigoRpc = corpoRpc.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const reg = (n, over = {}) => ({
  pagamento_id: U(n), numero_parcela_completo: String(590000000000 + n),
  matricula: String(900000000 + n), arquivo_origem: "sintetico.xlsx",
  linha_no_arquivo: n, ...over });

async function bancada() {
  const db = await PGlite.create();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.pagamentos (id uuid primary key, numero_parcela_completo text,
      matricula text, tipo_pagamento text);`);
  await db.exec(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
  await db.exec(sqlPrep);
  await db.exec(sqlMotor);
  await db.exec(sqlRpc);

  /** chama a RPC como service_role -- o que o PostgREST faz com SET LOCAL ROLE */
  db.carregar = async (lote, registros, papel = "service_role") => {
    try {
      await db.exec(`set role ${papel};`);
      const r = await db.query(
        `select public.backfill_matricula_stage_carregar($1,$2::jsonb) r`,
        [lote, JSON.stringify(registros)]);
      return { ok: true, valor: r.rows[0].r };
    } catch (e) {
      return { ok: false, erro: e.message };
    } finally { await db.exec(`reset role;`); }
  };
  db.conta = async (onde = "true") => Number((await db.query(
    `select count(*) c from public.backfill_matricula_stage where ${onde}`)).rows[0].c);
  db.priv = async (papel, priv) => (await db.query(
    `select has_table_privilege($1,'public.backfill_matricula_stage',$2) x`, [papel, priv])).rows[0].x;
  db.execPriv = async (papel, assinatura) => (await db.query(
    `select has_function_privilege($1,$2,'EXECUTE') x`, [papel, assinatura])).rows[0].x;
  return db;
}

describe("ACL: a porta fecha na tabela e abre so na funcao", () => {
  let db;
  beforeAll(async () => { db = await bancada(); }, 60000);

  it.each(["INSERT", "SELECT", "UPDATE", "DELETE"])(
    "service_role NAO tem %s direto na stage", async (p) => {
      expect(await db.priv("service_role", p)).toBe(false);
    });
  it.each(["anon", "authenticated"])("%s nao alcanca a stage", async (papel) => {
    for (const p of ["INSERT", "SELECT"]) expect(await db.priv(papel, p)).toBe(false);
  });
  it("service_role TEM execute na rpc de carga", async () => {
    expect(await db.execPriv("service_role",
      "public.backfill_matricula_stage_carregar(text, jsonb)")).toBe(true);
  });
  it.each(["public", "anon", "authenticated"])(
    "%s NAO executa a rpc de carga", async (papel) => {
      expect(await db.execPriv(papel,
        "public.backfill_matricula_stage_carregar(text, jsonb)")).toBe(false);
    });
  it("service_role continua sem EXECUTE no motor", async () => {
    expect(await db.execPriv("service_role",
      "public.backfill_matricula_aplicar(text, text, integer)")).toBe(false);
  });
  it("a funcao e SECURITY DEFINER e do postgres", async () => {
    const r = await db.query(`select p.prosecdef, pg_get_userbyid(p.proowner) dono,
        array_to_string(p.proconfig,',') cfg
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='backfill_matricula_stage_carregar'`);
    expect(r.rows[0].prosecdef).toBe(true);
    expect(r.rows[0].dono).toBe("postgres");
    expect(r.rows[0].cfg).toMatch(/search_path=public, pg_temp/);
  });
});

describe("gate de papel", () => {
  let db;
  beforeAll(async () => { db = await bancada(); }, 60000);

  it("service_role executa", async () => {
    const r = await db.carregar("L1", [reg(1)]);
    expect(r.ok, r.erro).toBe(true);
    expect(r.valor).toEqual({ lote: "L1", recebidos: 1 });
  });
  it("o dono (postgres) NAO executa -- a rpc e da Edge", async () => {
    const r = await db.query(`select 1`).then(async () => {
      try {
        await db.query(`select public.backfill_matricula_stage_carregar('L','[]'::jsonb)`);
        return { ok: true };
      } catch (e) { return { ok: false, erro: e.message }; }
    });
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/exclusiva de service_role/);
  });
  it.each(["anon", "authenticated"])("%s nem alcanca a funcao", async (papel) => {
    const r = await db.carregar("L", [reg(1)], papel);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/permission denied|permissão negada/i);
  });
});

describe("carga e idempotencia", () => {
  let db;
  beforeAll(async () => { db = await bancada(); }, 60000);

  it("um pedaco de 100 entra inteiro", async () => {
    const chunk = Array.from({ length: 100 }, (_, i) => reg(i + 1));
    const r = await db.carregar("LOTE_A", chunk);
    expect(r.ok, r.erro).toBe(true);
    expect(r.valor.recebidos).toBe(100);
    expect(await db.conta(`lote='LOTE_A'`)).toBe(100);
  });
  it("reenviar o MESMO pedaco nao duplica", async () => {
    const chunk = Array.from({ length: 100 }, (_, i) => reg(i + 1));
    const r = await db.carregar("LOTE_A", chunk);
    expect(r.ok).toBe(true);
    expect(await db.conta(`lote='LOTE_A'`)).toBe(100);
  });
  it("CONFLITO NAO SOBRESCREVE: matricula diferente nao altera o que ja entrou", async () => {
    await db.carregar("LOTE_A", [reg(1, { matricula: "111111111" })]);
    const v = await db.query(
      `select matricula from public.backfill_matricula_stage
        where lote='LOTE_A' and pagamento_id=$1`, [U(1)]);
    expect(v.rows[0].matricula).toBe(String(900000000 + 1));
  });
  it("conflito tambem nao altera boleto, arquivo nem linha", async () => {
    await db.carregar("LOTE_A", [reg(2, {
      numero_parcela_completo: "999", arquivo_origem: "OUTRO.xlsx", linha_no_arquivo: 9999 })]);
    const v = await db.query(
      `select numero_parcela_completo, arquivo_origem, linha_no_arquivo
         from public.backfill_matricula_stage where lote='LOTE_A' and pagamento_id=$1`, [U(2)]);
    expect(v.rows[0].numero_parcela_completo).toBe(String(590000000000 + 2));
    expect(v.rows[0].arquivo_origem).toBe("sintetico.xlsx");
    expect(v.rows[0].linha_no_arquivo).toBe(2);
  });
  it("lote diferente e outra gaveta", async () => {
    const r = await db.carregar("LOTE_B", [reg(1)]);
    expect(r.ok).toBe(true);
    expect(await db.conta(`lote='LOTE_B'`)).toBe(1);
    expect(await db.conta(`lote='LOTE_A'`)).toBe(100);
  });
});

describe("validacao: tudo que a rpc recusa", () => {
  let db;
  beforeAll(async () => { db = await bancada(); }, 60000);
  const recusa = async (nome, lote, registros, agulha) => {
    const antes = await db.conta();
    const r = await db.carregar(lote, registros);
    expect(r.ok, `${nome} deveria recusar`).toBe(false);
    expect(r.erro).toMatch(agulha);
    expect(await db.conta(), `${nome} mexeu na stage`).toBe(antes);
  };

  it("lote vazio", () => recusa("lote vazio", "   ", [reg(1)], /lote obrigatorio/));
  it("registros nao e array", async () => {
    const antes = await db.conta();
    let erro = null;
    try {
      await db.exec(`set role service_role;`);
      await db.query(`select public.backfill_matricula_stage_carregar('L','{"a":1}'::jsonb)`);
    } catch (e) { erro = e.message; } finally { await db.exec(`reset role;`); }
    expect(erro).toMatch(/array jsonb/);
    expect(await db.conta()).toBe(antes);
  });
  it("array vazio", () => recusa("vazio", "L", [], /nenhum registro/));
  it("acima de 100 registros", () =>
    recusa("101", "L", Array.from({ length: 101 }, (_, i) => reg(i + 1)), /no maximo 100/));
  it("campo a menos", async () => {
    const semMatricula = reg(1);
    delete semMatricula.matricula;
    await recusa("campo a menos", "L", [semMatricula], /exatamente os cinco campos/);
  });
  it("campo a mais", () =>
    recusa("campo a mais", "L", [reg(1, { extra: "x" })], /exatamente os cinco campos/));
  it("campo vazio", () =>
    recusa("vazio", "L", [reg(1, { matricula: "   " })], /campo obrigatorio vazio/));
  it("uuid invalido", () =>
    recusa("uuid", "L", [reg(1, { pagamento_id: "nao-e-uuid" })], /formato uuid/));
  it("linha_no_arquivo como texto", () =>
    recusa("texto", "L", [reg(1, { linha_no_arquivo: "5" })], /inteiro positivo/));
  it("linha_no_arquivo zero", () =>
    recusa("zero", "L", [reg(1, { linha_no_arquivo: 0 })], /inteiro positivo/));
  it("linha_no_arquivo negativa", () =>
    recusa("negativa", "L", [reg(1, { linha_no_arquivo: -3 })], /inteiro positivo/));
  it("um registro invalido no meio recusa o PEDACO INTEIRO", () =>
    recusa("meio", "L", [reg(1), reg(2, { matricula: "" }), reg(3)], /campo obrigatorio vazio/));
  it("a mensagem de erro nao ecoa o conteudo do registro", async () => {
    const r = await db.carregar("L", [reg(7, { matricula: "   ", arquivo_origem: "SEGREDO_VAZADO" })]);
    expect(r.ok).toBe(false);
    expect(r.erro).not.toMatch(/SEGREDO_VAZADO|900000|590000/);
  });
});

describe("escopo: a rpc nao alcanca nada alem da stage", () => {
  let db;
  beforeAll(async () => { db = await bancada(); }, 60000);

  it("nao nomeia pagamentos, lotes, origem nem o motor", () => {
    expect(codigoRpc).not.toMatch(/public\.pagamentos/);
    expect(codigoRpc).not.toMatch(/backfill_matricula_lotes|backfill_matricula_origem/);
    expect(codigoRpc).not.toMatch(/backfill_matricula_aplicar/);
  });
  it("nao tem SQL dinamico", () => {
    expect(codigoRpc).not.toMatch(/\bexecute\b/i);
  });
  it("usa ON CONFLICT DO NOTHING, nunca DO UPDATE", () => {
    expect(codigoRpc).toMatch(/on conflict \(lote, pagamento_id\) do nothing/);
    expect(codigoRpc).not.toMatch(/do\s+update/i);
  });
  it("search_path fixo com pg_temp por ultimo", () => {
    // fica no cabecalho da funcao, nao no corpo
    expect(sqlRpc).toMatch(/ set search_path to 'public', 'pg_temp'/);
  });
  it("na pratica: carregar nao altera pagamentos", async () => {
    await db.query(`insert into public.pagamentos values ($1,'x',null,'SANTANDER')`, [U(500)]);
    const antes = (await db.query(`select md5(string_agg(id::text||coalesce(matricula,''),',')) h
      from public.pagamentos`)).rows[0].h;
    await db.carregar("L", [reg(1)]);
    const depois = (await db.query(`select md5(string_agg(id::text||coalesce(matricula,''),',')) h
      from public.pagamentos`)).rows[0].h;
    expect(depois).toBe(antes);
  });
  it("na pratica: carregar nao toca lotes nem origem", async () => {
    await db.carregar("L", [reg(9)]);
    for (const t of ["backfill_matricula_lotes", "backfill_matricula_origem"]) {
      const v = await db.query(`select count(*) c from public.${t}`);
      expect(Number(v.rows[0].c), t).toBe(0);
    }
  });
  it("hijacking de search_path nao muda o alvo", async () => {
    // objeto plantado no schema temporario do chamador nao e alcancado, porque
    // o search_path da funcao e fixo e pg_temp vem por ultimo.
    await db.exec(`create temp table backfill_matricula_stage (x int);`);
    const r = await db.carregar("L_HIJACK", [reg(42)]);
    expect(r.ok, r.erro).toBe(true);
    expect(await db.conta(`lote='L_HIJACK'`)).toBe(1);
  });
});

describe("escala: 100 por chamada, muito abaixo dos 10 s", () => {
  let db, tempos;
  beforeAll(async () => {
    db = await bancada();
    tempos = [];
    for (let i = 1; i <= 7401; i += 100) {
      const chunk = [];
      for (let k = i; k < Math.min(i + 100, 7402); k++) chunk.push(reg(k));
      const t0 = performance.now();
      const r = await db.carregar("LOTE_GRANDE", chunk);
      tempos.push(performance.now() - t0);
      expect(r.ok, r.erro).toBe(true);
    }
  }, 180000);

  it("as 7.401 linhas chegam", async () => {
    expect(await db.conta(`lote='LOTE_GRANDE'`)).toBe(7401);
  });
  it("foram 75 chamadas de no maximo 100", () => expect(tempos.length).toBe(75));
  it("cada chamada fica MUITO abaixo do limiar do auto_explain", () => {
    // 10.000 ms e o limiar em producao. Teto de 1 s: uma ordem de grandeza de
    // folga sem depender da carga da maquina do CI.
    expect(Math.max(...tempos)).toBeLessThan(1000);
  });
  it("reenviar a carga inteira nao duplica", async () => {
    for (let i = 1; i <= 7401; i += 100) {
      const chunk = [];
      for (let k = i; k < Math.min(i + 100, 7402); k++) chunk.push(reg(k));
      await db.carregar("LOTE_GRANDE", chunk);
    }
    expect(await db.conta(`lote='LOTE_GRANDE'`)).toBe(7401);
  });
});

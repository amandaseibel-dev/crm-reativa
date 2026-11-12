// ACOES MASSIVAS: correcao do recorte por responsavel pelo CASO (migration v2).
//
// Parte da DEFINICAO PUBLICADA em producao (fixture prod_20261112_universo.sql,
// MD5 88ec923f40294febcd4376491102b37d, capturada por leitura de pg_get_functiondef),
// reproduz o defeito e depois aplica a migration v2 INTEIRA, com a guarda de MD5.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  novoBanco, comoGestao, alunos, universo, exportar,
  OP_A, OP_B, OP_INATIVA,
} from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const lerFix = (n) => readFileSync(resolve(AQUI, "fixtures/acoes_massivas_universo", n), "utf8");
const PROD_DEF = lerFix("prod_20261112_universo.sql");
const V2 = readFileSync(resolve(AQUI, "..", "migrations/20261029183847_acoes_massivas_universo_consolidado_v2.sql"), "utf8");
const MD5_PROD = "88ec923f40294febcd4376491102b37d";

let db;
beforeEach(async () => {
  db = await novoBanco();              // cadeia de migrations do repositorio
  await db.exec(PROD_DEF);             // substitui pela definicao publicada em producao
  await comoGestao(db);
});

const disp = (rows) => rows.filter((r) => r.disponivel).map((r) => r.aluno_id).sort();
const motivo = (rows, id) => rows.find((r) => r.aluno_id === id)?.motivo;
const md5Def = async () => (await db.query(
  "select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_universo'"
)).rows[0].m;

describe("fixture de producao", () => {
  it("a definicao instalada tem o MD5 publicado", async () => {
    expect(await md5Def()).toBe(MD5_PROD);
  });
});

describe("defeito antes da v2 (definicao de producao)", () => {
  it("selecao por caso com um responsavel devolve zero casos", async () => {
    await alunos(db, 3, { dono: OP_A, ini: 1 });
    const r = await universo(db, { operador: `caso:${OP_A}`, responsaveis_caso: [OP_A], tipo_cobranca: "MENSALIDADES_E_ACORDOS" });
    expect(disp(r)).toEqual([]);
  });
});

describe("correcao depois da v2 (guarda de MD5 preservada)", () => {
  beforeEach(async () => { await db.exec(V2); });

  it("a v2 instala a definicao com o MD5 validado", async () => {
    expect(await md5Def()).toBe("7f791a02ddbfdf79d1e173e7e9660ce7");
  });

  it("um responsavel por caso: traz so os dele", async () => {
    const a = await alunos(db, 3, { dono: OP_A, ini: 1 });
    await alunos(db, 2, { dono: OP_B, ini: 11 });
    const r = await universo(db, { operador: `caso:${OP_A}`, responsaveis_caso: [OP_A], tipo_cobranca: "MENSALIDADES_E_ACORDOS" });
    expect(disp(r)).toEqual([...a].sort());
  });

  it("varios responsaveis por caso: traz a uniao, e ninguem alem", async () => {
    const a = await alunos(db, 2, { dono: OP_A, ini: 1 });
    const b = await alunos(db, 2, { dono: OP_B, ini: 11 });
    const c = await alunos(db, 2, { dono: OP_INATIVA, ini: 21 });
    const r = await universo(db, { operador: `caso:${OP_A}|${OP_B}`, responsaveis_caso: [OP_A, OP_B], tipo_cobranca: "MENSALIDADES_E_ACORDOS" });
    expect(disp(r)).toEqual([...a, ...b].sort());
    for (const id of c) expect(motivo(r, id)).toBe("outro_responsavel");
  });

  it("livres: nao filtra por responsavel e nao duplica aluno", async () => {
    const a = await alunos(db, 2, { dono: OP_A, ini: 1 });
    const r = await universo(db, { operador: "livres", tipo_cobranca: "MENSALIDADES_E_ACORDOS" });
    const ids = r.map((x) => x.aluno_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of a) expect(disp(r)).toContain(id);
  });

  it("sem selecao explicita, o comportamento antigo fica intacto", async () => {
    const a = await alunos(db, 2, { dono: OP_A, ini: 1 });
    const antes = await universo(db, { operador: OP_A, tipo_cobranca: "MENSALIDADES_E_ACORDOS" });
    expect(disp(antes)).toEqual([...a].sort());
  });

  it("previa e exportacao usam o mesmo universo: exportar com a mesma selecao nao amplia", async () => {
    const a = await alunos(db, 2, { dono: OP_A, ini: 1 });
    await alunos(db, 2, { dono: OP_B, ini: 11 });
    const f = { operador: `caso:${OP_A}`, responsaveis_caso: [OP_A], tipo_cobranca: "MENSALIDADES_E_ACORDOS" };
    const r = await universo(db, f);
    const ids = disp(r);
    expect(ids).toEqual([...a].sort());
    const exp = await exportar(db, ids, { canal: "WHATSAPP", operador: `caso:${OP_A}`, tipo: "MENSALIDADES_E_ACORDOS" });
    expect(Number(exp.selecionados ?? exp.exportados ?? 0)).toBeLessThanOrEqual(ids.length);
  });

  it("rollback: reinstalar a definicao de producao devolve o defeito", async () => {
    await alunos(db, 2, { dono: OP_A, ini: 1 });
    await db.exec(PROD_DEF);
    expect(await md5Def()).toBe(MD5_PROD);
    const r = await universo(db, { operador: `caso:${OP_A}`, responsaveis_caso: [OP_A], tipo_cobranca: "MENSALIDADES_E_ACORDOS" });
    expect(disp(r)).toEqual([]);
  });
});

describe("recusa diante de definicao inesperada", () => {
  it("a v2 aborta se a funcao tiver sido alterada", async () => {
    await db.exec(PROD_DEF.replace("$function$\n", "-- alterado\n$function$\n"));
    await expect(db.exec(V2)).rejects.toThrow(/PRE-CONDICAO|definicao viva difere/);
  });
});

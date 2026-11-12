// ACOES MASSIVAS: migration COMBINADA 20261112120000 (v2 por responsavel pelo caso
// + fidelizacao ate o 10o dia em America/Sao_Paulo, TODOS e CASO).
//
// Parte da DEFINICAO PUBLICADA em producao (fixtures prod_20261112_*.sql, MD5 de
// origem 88ec923f... e 9c4c8486...), reproduz o defeito, aplica a migration e
// comprova as regras. Rollback: restaura a definicao publicada.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  novoBanco, comoGestao, alunos, universo, acordoVencido,
  OP_A, OP_B, OP_INATIVA,
} from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(AQUI, "fixtures/acoes_massivas_universo");
const ler = (p) => readFileSync(p, "utf8");
const PROD_UNIVERSO = ler(resolve(FIX, "prod_20261112_universo.sql"));
const PROD_EXPORT_EMAIL = ler(resolve(FIX, "prod_20261112_exportar_emails_do_lote.sql"));
const MIG = ler(resolve(AQUI, "../migrations/20261112120000_acoes_massivas_caso_fidelizacao_combinada.sql"));
const MD5_PROD_UNIVERSO = "88ec923f40294febcd4376491102b37d";
const MD5_FINAL_UNIVERSO = "cefd206824186d4da8e6f1e35c14beb8";
const MD5_PROD_EXPORT = "9c4c8486b2436a573c0ba589428c172c";
const MD5_FINAL_EXPORT = "00d3370a7800bd334292808e1573a57d";

const CASO_A = { operador: `caso:${OP_A}`, responsaveis_caso: [OP_A], tipo_cobranca: "MENSALIDADES_E_ACORDOS" };
const TODOS = { operador: "todos", tipo_cobranca: "MENSALIDADES_E_ACORDOS" };

let db;
beforeEach(async () => {
  db = await novoBanco();
  await db.exec(PROD_UNIVERSO);       // publicado hoje em producao
  await db.exec(PROD_EXPORT_EMAIL);
  await comoGestao(db);
});

const md5 = async (nome) => (await db.query(
  "select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1",
  [nome])).rows[0].m;
const disp = (rows) => rows.filter((r) => r.disponivel).map((r) => r.aluno_id).sort();
const motivo = (rows, id) => rows.find((r) => r.aluno_id === id)?.motivo;

describe("publicado hoje (antes da migration)", () => {
  it("MD5 de origem confere com o publicado", async () => {
    expect(await md5("acoes_massivas_universo")).toBe(MD5_PROD_UNIVERSO);
    expect(await md5("acoes_massivas_exportar_emails_do_lote")).toBe(MD5_PROD_EXPORT);
  });
  it("defeito: selecao por caso com um responsavel devolve zero", async () => {
    await alunos(db, 3, { dono: OP_A, ini: 1 });
    expect(disp(await universo(db, CASO_A))).toEqual([]);
  });
});

describe("depois da migration combinada", () => {
  beforeEach(async () => { await db.exec(MIG); });

  it("MD5 final confere com o validado", async () => {
    expect(await md5("acoes_massivas_universo")).toBe(MD5_FINAL_UNIVERSO);
    expect(await md5("acoes_massivas_exportar_emails_do_lote")).toBe(MD5_FINAL_EXPORT);
  });

  it("um responsavel por caso traz so os dele", async () => {
    const a = await alunos(db, 3, { dono: OP_A, ini: 1, acionadoDias: 30 });
    await alunos(db, 2, { dono: OP_B, ini: 11, acionadoDias: 30 });
    expect(disp(await universo(db, CASO_A))).toEqual([...a].sort());
  });

  it("varios responsaveis: uniao, sem duplicidade e sem o inativo", async () => {
    const a = await alunos(db, 2, { dono: OP_A, ini: 1, acionadoDias: 30 });
    const b = await alunos(db, 2, { dono: OP_B, ini: 11, acionadoDias: 30 });
    const c = await alunos(db, 2, { dono: OP_INATIVA, ini: 21, acionadoDias: 30 });
    const r = await universo(db, { operador: `caso:${OP_A}|${OP_B}`, responsaveis_caso: [OP_A, OP_B], tipo_cobranca: "MENSALIDADES_E_ACORDOS" });
    expect(disp(r)).toEqual([...a, ...b].sort());
    expect(new Set(r.map((x) => x.aluno_id)).size).toBe(r.length);
    for (const id of c) expect(motivo(r, id)).toBe("outro_responsavel");
  });

  it("livres: sem duplicidade", async () => {
    await alunos(db, 4, { dono: OP_A, ini: 1, acionadoDias: 30 });
    const r = await universo(db, { operador: "livres", tipo_cobranca: "MENSALIDADES_E_ACORDOS" });
    expect(new Set(r.map((x) => x.aluno_id)).size).toBe(r.length);
  });

  it("fidelizacao: acionado ha 10 dias continua protegido (TODOS e CASO)", async () => {
    const prot = await alunos(db, 2, { dono: OP_A, ini: 1, acionadoDias: 10 });
    const r1 = await universo(db, TODOS);
    const r2 = await universo(db, CASO_A);
    for (const id of prot) {
      expect(motivo(r1, id)).toBe("fidelizacao_ativa");
      expect(motivo(r2, id)).toBe("fidelizacao_ativa");
    }
  });

  it("11o dia: acionado ha 11 dias fica liberado (TODOS e CASO)", async () => {
    const lib = await alunos(db, 2, { dono: OP_A, ini: 1, acionadoDias: 11 });
    expect(disp(await universo(db, TODOS))).toEqual([...lib].sort());
    expect(disp(await universo(db, CASO_A))).toEqual([...lib].sort());
  });

  it("sem responsavel nao e protegido pela fidelizacao (regra so vale com responsavel)", async () => {
    const sem = await alunos(db, 2, { dono: null, ini: 31, acionadoDias: 2 });
    for (const id of sem) expect(motivo(await universo(db, TODOS), id)).not.toBe("fidelizacao_ativa");
  });

  it("acordo vencido do proprio dono continua no universo do caso", async () => {
    const [id] = await alunos(db, 1, { dono: OP_A, ini: 41, acionadoDias: 30 });
    await acordoVencido(db, id, OP_A);
    expect(disp(await universo(db, CASO_A))).toContain(id);
  });

  it("rollback: reinstalar a definicao publicada devolve o defeito", async () => {
    await alunos(db, 2, { dono: OP_A, ini: 1, acionadoDias: 30 });
    await db.exec(PROD_UNIVERSO);
    await db.exec(PROD_EXPORT_EMAIL);
    expect(await md5("acoes_massivas_universo")).toBe(MD5_PROD_UNIVERSO);
    expect(disp(await universo(db, CASO_A))).toEqual([]);
  });
});

describe("recusa diante de definicao inesperada", () => {
  it("a migration aborta se a funcao publicada tiver sido alterada", async () => {
    await db.exec(PROD_UNIVERSO.replace("$function$\n", "-- alterado\n$function$\n"));
    await expect(db.exec(MIG)).rejects.toThrow(/Nada aplicado|PRE|diferente|esperado/i);
  });
});

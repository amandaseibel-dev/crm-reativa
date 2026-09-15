// TRANSPORTADOR DA STAGE -- Edge `backfill-matricula-carga`.
//
// DUAS CAMADAS, E UM LIMITE DITO DE FRENTE.
//
// ESTRUTURA: o texto da Edge -- que ela nao imprime o corpo, nao aceita query
// string, so devolve contagem, e nao alcanca o motor de aplicacao.
//
// COMPORTAMENTO: o handler REAL e exercido contra um Postgres REAL (PGlite),
// com a migration do #386 aplicada. O que o teste injeta e apenas a funcao
// `inserir` -- que faz o INSERT de verdade na stage.
//
// O QUE ISTO NAO PROVA: o salto PostgREST. Esta maquina nao tem Deno, nem
// Docker, nem stack local do Supabase, e fazer deploy esta vetado. Entao a
// cadeia provada e `caller -> handler real -> INSERT real na stage real`, com o
// hop HTTP/PostgREST SIMULADO. O que o hop acrescentaria e a traducao
// upsert->SQL e a ACL de `service_role`, e essa ACL e medida a parte, no banco,
// no arquivo de comportamento do motor.
//
// NENHUM DADO REAL. Todo UUID, matricula, boleto e arquivo aqui e inventado.
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { criarHandler, assinar, sha256Hex, iguaisEmTempoConstante, registroInvalido, MAX_REGISTROS }
  from "../functions/backfill-matricula-carga/index.ts";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const EDGE = resolve(RAIZ, "supabase/functions/backfill-matricula-carga/index.ts");
const MIG = resolve(RAIZ, "supabase/migrations/20260915140000_backfill_matricula_prime_motor.sql");
const fonte = readFileSync(EDGE, "utf8").replace(/\r/g, "");
const semComentario = (t) =>
  t.split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")).join("\n");
const codigo = semComentario(fonte);

const SEGREDO = "segredo-sintetico-de-teste";
const LOTE = "LOTE_SINTETICO";
const HASH = "0".repeat(32);
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const reg = (n) => ({
  pagamento_id: U(n), numero_parcela_completo: String(590000000000 + n),
  matricula: String(900000000 + n), arquivo_origem: "sintetico.xlsx", linha_no_arquivo: n });

describe("estrutura: o que a Edge nao faz", () => {
  it("nao imprime nada -- nem corpo, nem registro", () => {
    expect(codigo).not.toMatch(/console\.(log|info|debug|warn|error)/);
  });
  it("recusa query string em vez de aceita-la", () => {
    expect(codigo).toMatch(/url\.search !== ""/);
    expect(codigo).toMatch(/esta rota nao aceita query string/);
  });
  it("nao alcanca o motor de aplicacao", () => {
    // o CODIGO, nao o comentario: o bloco de ciclo de vida cita a funcao de
    // aplicacao para explicar a ordem dos passos -- e nao e chamada nenhuma.
    expect(codigo).not.toMatch(/backfill_matricula_aplicar/);
    expect(codigo).not.toMatch(/\.rpc\(/);
  });
  it("so toca a stage, e so para inserir", () => {
    expect(codigo).toMatch(/from\("backfill_matricula_stage"\)/);
    expect(codigo).not.toMatch(/\.select\(|\.delete\(|\.update\(/);
    expect(codigo).toMatch(/ignoreDuplicates: true/);
  });
  it("o segredo vem do ambiente, nunca do codigo", () => {
    expect(codigo).toMatch(/env\("BACKFILL_CARGA_TOKEN"\)/);
    expect(codigo).not.toMatch(/BACKFILL_CARGA_TOKEN\s*=\s*"/);
  });
  it("a resposta de erro cita a POSICAO do registro, nunca o conteudo", () => {
    expect(codigo).toMatch(/registro \$\{i\}: \$\{motivo\}/);
    expect(codigo).not.toMatch(/JSON\.stringify\(registros\[/);
  });
  it("compara segredo em tempo constante", () => {
    expect(codigo).toMatch(/iguaisEmTempoConstante\(token, segredo\)/);
  });
  it("tem teto de registros por requisicao", () => {
    expect(MAX_REGISTROS).toBeLessThanOrEqual(200);
    expect(codigo).toMatch(/no maximo \$\{MAX_REGISTROS\} registros/);
  });
});

describe("primitivas", () => {
  it("comparacao constante distingue igual de diferente", () => {
    expect(iguaisEmTempoConstante("abc", "abc")).toBe(true);
    expect(iguaisEmTempoConstante("abc", "abd")).toBe(false);
    expect(iguaisEmTempoConstante("abc", "abcd")).toBe(false);
  });
  it("a assinatura muda se QUALQUER parte mudar", async () => {
    const d = await sha256Hex("x");
    const base = await assinar(SEGREDO, LOTE, HASH, 0, d, 100);
    expect(await assinar(SEGREDO, "OUTRO", HASH, 0, d, 100)).not.toBe(base);
    expect(await assinar(SEGREDO, LOTE, "f".repeat(32), 0, d, 100)).not.toBe(base);
    expect(await assinar(SEGREDO, LOTE, HASH, 1, d, 100)).not.toBe(base);
    expect(await assinar(SEGREDO, LOTE, HASH, 0, await sha256Hex("y"), 100)).not.toBe(base);
    expect(await assinar(SEGREDO, LOTE, HASH, 0, d, 101)).not.toBe(base);
    expect(await assinar("outro-segredo", LOTE, HASH, 0, d, 100)).not.toBe(base);
  });
  it("a validacao de forma recusa o que deve", () => {
    expect(registroInvalido(reg(1))).toBeNull();
    expect(registroInvalido({ ...reg(1), pagamento_id: "nao-e-uuid" })).toMatch(/uuid/);
    expect(registroInvalido({ ...reg(1), matricula: "  " })).toMatch(/matricula/);
    expect(registroInvalido({ ...reg(1), linha_no_arquivo: 0 })).toMatch(/linha_no_arquivo/);
    expect(registroInvalido({ ...reg(1), linha_no_arquivo: 1.5 })).toMatch(/linha_no_arquivo/);
    expect(registroInvalido(null)).toMatch(/objeto/);
  });
});

async function novaBancada() {
  const db = await PGlite.create();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.pagamentos (id uuid primary key, numero_parcela_completo text,
      matricula text, tipo_pagamento text);`);
  await db.exec(readFileSync(MIG, "utf8"));
  const chamadas = [];
  const handler = criarHandler({
    env: (n) => (n === "BACKFILL_CARGA_TOKEN" ? SEGREDO : undefined),
    inserir: async (linhas) => {
      chamadas.push(linhas.length);
      const vals = linhas.map((_, k) => {
        const b = k * 6;
        return `($${b + 1},$${b + 2}::uuid,$${b + 3},$${b + 4},$${b + 5},$${b + 6}::int)`;
      }).join(",");
      const args = [];
      for (const l of linhas) args.push(l.lote, l.pagamento_id, l.numero_parcela_completo,
        l.matricula, l.arquivo_origem, l.linha_no_arquivo);
      const r = await db.query(`insert into public.backfill_matricula_stage
        (lote,pagamento_id,numero_parcela_completo,matricula,arquivo_origem,linha_no_arquivo)
        values ${vals} on conflict (lote, pagamento_id) do nothing returning 1`, args);
      return { inseridos: r.rows.length };
    },
  });
  db.handler = handler;
  db.chamadas = chamadas;
  db.enviar = async (registros, opc = {}) => {
    const lote = opc.lote ?? LOTE, hash = opc.hash ?? HASH;
    const indice = opc.indice ?? 0;
    const ts = opc.ts ?? Math.floor(Date.now() / 1000);
    const digesto = await sha256Hex(JSON.stringify(registros));
    const assinatura = opc.assinatura
      ?? await assinar(opc.segredo ?? SEGREDO, lote, hash, indice, digesto, ts);
    const metodo = opc.metodo ?? "POST";
    const init = {
      method: metodo,
      headers: { "content-type": "application/json",
                 "x-rotina-token": opc.token ?? SEGREDO },
    };
    // GET/HEAD nao podem ter corpo na API Request -- e justamente por isso que
    // o teste de metodo errado existe: a rota so aceita POST.
    if (metodo !== "GET" && metodo !== "HEAD")
      init.body = JSON.stringify({ lote, hash, indice, ts, assinatura, registros });
    const req = new Request(opc.url ?? "https://x/functions/v1/backfill-matricula-carga", init);
    const resp = await db.handler(req);
    return { status: resp.status, corpo: await resp.json() };
  };
  db.conta = async (onde = "true") => Number(
    (await db.query(`select count(*) c from public.backfill_matricula_stage where ${onde}`)).rows[0].c);
  return db;
}

describe("carga: caminho feliz e idempotencia", () => {
  let db;
  beforeAll(async () => { db = await novaBancada(); }, 60000);

  it("um pedaco de 100 entra inteiro", async () => {
    const chunk = Array.from({ length: 100 }, (_, i) => reg(i + 1));
    const r = await db.enviar(chunk, { indice: 0 });
    expect(r.status).toBe(200);
    expect(r.corpo).toEqual({ lote: LOTE, indice: 0, recebidos: 100, inseridos: 100 });
    expect(await db.conta()).toBe(100);
  });
  it("a resposta NAO devolve nenhum registro", async () => {
    const chunk = [reg(101)];
    const r = await db.enviar(chunk, { indice: 1 });
    expect(Object.keys(r.corpo).sort()).toEqual(["indice", "inseridos", "lote", "recebidos"]);
    expect(JSON.stringify(r.corpo)).not.toMatch(/900000|590000|00000000-0000/);
  });
  it("reenviar o MESMO pedaco nao duplica nem altera", async () => {
    const chunk = Array.from({ length: 100 }, (_, i) => reg(i + 1));
    const antes = await db.conta();
    const r = await db.enviar(chunk, { indice: 0 });
    expect(r.status).toBe(200);
    expect(r.corpo.inseridos).toBe(0);         // ON CONFLICT DO NOTHING
    expect(r.corpo.recebidos).toBe(100);
    expect(await db.conta()).toBe(antes);
  });
  it("pedaco repetido com matricula trocada NAO sobrescreve o que ja entrou", async () => {
    const adulterado = [{ ...reg(1), matricula: "111111111" }];
    await db.enviar(adulterado, { indice: 0 });
    const v = await db.query(
      `select matricula from public.backfill_matricula_stage where pagamento_id=$1`, [U(1)]);
    expect(v.rows[0].matricula).toBe(String(900000000 + 1));   // o original
  });
  it("lote diferente e outra gaveta -- nao colide", async () => {
    const chunk = [reg(1)];
    const r = await db.enviar(chunk, { lote: "LOTE_OUTRO", indice: 0 });
    expect(r.corpo.inseridos).toBe(1);
    expect(await db.conta(`lote='LOTE_OUTRO'`)).toBe(1);
    expect(await db.conta(`lote='${LOTE}'`)).toBe(101);
  });
});

describe("carga: tudo que deve ser recusado", () => {
  let db;
  beforeAll(async () => { db = await novaBancada(); }, 60000);
  const semEfeito = async (fn, status, agulha) => {
    const antes = await db.conta();
    const r = await fn();
    expect(r.status).toBe(status);
    expect(r.corpo.erro).toMatch(agulha);
    expect(await db.conta()).toBe(antes);
  };

  it("token errado", () => semEfeito(
    () => db.enviar([reg(1)], { token: "errado" }), 401, /nao autorizado/));
  it("token ausente", () => semEfeito(
    () => db.enviar([reg(1)], { token: "" }), 401, /nao autorizado/));
  it("assinatura invalida", () => semEfeito(
    () => db.enviar([reg(1)], { assinatura: "f".repeat(64) }), 401, /assinatura invalida/));
  it("assinatura de OUTRO lote (replay cruzado)", () => semEfeito(
    async () => {
      const chunk = [reg(1)];
      const d = await sha256Hex(JSON.stringify(chunk));
      const ts = Math.floor(Date.now() / 1000);
      const a = await assinar(SEGREDO, "LOTE_ALHEIO", HASH, 0, d, ts);
      return db.enviar(chunk, { assinatura: a, ts });
    }, 401, /assinatura invalida/));
  it("assinatura de OUTRO hash", () => semEfeito(
    async () => {
      const chunk = [reg(1)];
      const d = await sha256Hex(JSON.stringify(chunk));
      const ts = Math.floor(Date.now() / 1000);
      const a = await assinar(SEGREDO, LOTE, "f".repeat(32), 0, d, ts);
      return db.enviar(chunk, { assinatura: a, ts });
    }, 401, /assinatura invalida/));
  it("corpo trocado depois de assinado", () => semEfeito(
    async () => {
      const chunk = [reg(1)];
      const d = await sha256Hex(JSON.stringify(chunk));
      const ts = Math.floor(Date.now() / 1000);
      const a = await assinar(SEGREDO, LOTE, HASH, 0, d, ts);
      return db.enviar([reg(2)], { assinatura: a, ts });   // assinou 1, mandou 2
    }, 401, /assinatura invalida/));
  it("assinatura velha -- fora da janela", () => semEfeito(
    () => db.enviar([reg(1)], { ts: Math.floor(Date.now() / 1000) - 3600 }),
    401, /fora da janela/));
  it("assinatura do futuro", () => semEfeito(
    () => db.enviar([reg(1)], { ts: Math.floor(Date.now() / 1000) + 3600 }),
    401, /fora da janela/));
  it("query string na URL", () => semEfeito(
    () => db.enviar([reg(1)], { url: "https://x/functions/v1/backfill-matricula-carga?a=1" }),
    400, /query string/));
  it("metodo diferente de POST", () => semEfeito(
    () => db.enviar([reg(1)], { metodo: "GET" }), 405, /use POST/));
  it("pedaco maior que o teto", () => semEfeito(
    () => db.enviar(Array.from({ length: MAX_REGISTROS + 1 }, (_, i) => reg(i + 1))),
    413, /no maximo/));
  it("pedaco vazio", () => semEfeito(() => db.enviar([]), 400, /registros obrigatorios/));
  it("registro invalido no meio -- recusa o PEDACO INTEIRO", () => semEfeito(
    () => db.enviar([reg(1), { ...reg(2), matricula: "" }, reg(3)]),
    400, /registro 1: matricula/));
  it("o erro de registro invalido nao ecoa o conteudo", async () => {
    // campo com TIPO errado, carregando um valor que nao pode aparecer na
    // resposta. A mensagem deve citar a posicao e o campo -- nunca o valor.
    const r = await db.enviar([{ ...reg(7), linha_no_arquivo: "SEGREDO_VAZADO" }]);
    expect(r.status).toBe(400);
    expect(r.corpo.erro).toMatch(/registro 0: linha_no_arquivo/);
    expect(JSON.stringify(r.corpo)).not.toMatch(/SEGREDO_VAZADO|590000|00000000-0000/);
  });
  it("lote ausente", () => semEfeito(() => db.enviar([reg(1)], { lote: "" }), 400, /lote obrigatorio/));
  it("hash ausente", () => semEfeito(() => db.enviar([reg(1)], { hash: "" }), 400, /hash obrigatorio/));
});

describe("escala: 7.401 registros em pedacos de 100", () => {
  let db, tempos, total;
  beforeAll(async () => {
    db = await novaBancada();
    const N = 7401, BLOCO = 100;
    tempos = [];
    for (let i = 1; i <= N; i += BLOCO) {
      const chunk = [];
      for (let k = i; k < Math.min(i + BLOCO, N + 1); k++) chunk.push(reg(k));
      const t0 = performance.now();
      const r = await db.enviar(chunk, { indice: Math.floor(i / BLOCO) });
      tempos.push(performance.now() - t0);
      expect(r.status).toBe(200);
    }
    total = await db.conta();
  }, 180000);

  it("as 7.401 linhas chegam na stage", () => expect(total).toBe(7401));
  it("foram 75 pedacos de no maximo 100", () => {
    expect(tempos.length).toBe(75);
    expect(Math.max(...db.chamadas)).toBeLessThanOrEqual(100);
  });
  it("cada pedaco fica MUITO abaixo dos 10 s do auto_explain", () => {
    // 10.000 ms e o limiar em producao. O teto de 1 s da uma ordem de grandeza
    // de folga sem depender da carga da maquina que roda o CI -- medido nesta
    // maquina, o pior pedaco fica na casa das dezenas de milissegundos.
    expect(Math.max(...tempos)).toBeLessThan(1000);
  });
  it("reenviar a carga inteira nao duplica nada", async () => {
    for (let i = 1; i <= 7401; i += 100) {
      const chunk = [];
      for (let k = i; k < Math.min(i + 100, 7402); k++) chunk.push(reg(k));
      await db.enviar(chunk, { indice: Math.floor(i / 100) });
    }
    expect(await db.conta()).toBe(7401);
  });
});

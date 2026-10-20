import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// A ficha inteira nao e renderizada aqui: o que se prova e a REGRA DE VALOR do
// re-acordo e a consulta que traz a mensalidade presa em acordo cancelado.
vi.mock("../services/supabase", () => ({ supabase: { from: () => ({}), rpc: () => ({}) } }));

import { somarSelecao } from "./FinanceiroAluno";

const CODIGO = fs.readFileSync(
  path.join(new URL("../..", import.meta.url).pathname, "src/components/FinanceiroAluno.jsx"),
  "utf8"
);
// Comentario nao e codigo: a ancora tem de estar no que roda.
const CODIGO_SEM_COMENTARIO = CODIGO
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

// Caso real: Thomas Henrique Campos Todeschini (24/09/2026). Duas mensalidades
// de R$ 284,20 e R$ 284,21 negociadas no acordo 4567, que foi cancelado; o
// saldo residual do acordo e R$ 669,35 -- do acordo, nao de cada mensalidade.
const T1 = {
  id: "t1", valor_original: 284.2,
  reacordo: { acordoId: "a-cancelado", numero: 4567, residual: 669.35, titulos: 2 },
};
const T2 = {
  id: "t2", valor_original: 284.21,
  reacordo: { acordoId: "a-cancelado", numero: 4567, residual: 669.35, titulos: 2 },
};
const COMUM = { id: "t3", valor_original: 100 };

describe("somarSelecao", () => {
  it("conta o saldo residual UMA vez, por acordo de origem, e nao por mensalidade", () => {
    expect(somarSelecao([T1, T2], ["t1", "t2"])).toBe(669.35);
  });

  it("nao usa o valor original da mensalidade de re-acordo", () => {
    // 284,20 + 284,21 = 568,41 e o valor de bordero, nao o que se renegocia.
    expect(somarSelecao([T1, T2], ["t1", "t2"])).not.toBe(568.41);
  });

  it("soma mensalidade comum pelo valor dela", () => {
    expect(somarSelecao([COMUM], ["t3"])).toBe(100);
  });

  it("mistura: residual do acordo cancelado + mensalidade solta", () => {
    expect(somarSelecao([T1, T2, COMUM], ["t1", "t2", "t3"])).toBe(769.35);
  });

  it("residual de dois acordos cancelados diferentes entra uma vez cada", () => {
    const outro = { id: "t4", reacordo: { acordoId: "b-cancelado", numero: 9, residual: 50, titulos: 1 } };
    expect(somarSelecao([T1, T2, outro], ["t1", "t2", "t4"])).toBe(719.35);
  });

  it("nada marcado soma zero", () => {
    expect(somarSelecao([T1, T2, COMUM], [])).toBe(0);
  });
});

describe("consulta das mensalidades disponiveis", () => {
  it("traz a mensalidade NEGOCIADA presa em acordo cancelado, nao so em_aberto", () => {
    // Sem este ramo a mensalidade do re-acordo nunca chega na tela e a gestao
    // nao tem o que marcar -- era a causa do 'nao consigo vincular'.
    expect(CODIGO_SEM_COMENTARIO).toMatch(/\.eq\("status", "vinculada"\)/);
    expect(CODIGO_SEM_COMENTARIO).toMatch(/\.eq\("situacao", "NEGOCIADO"\)/);
    expect(CODIGO_SEM_COMENTARIO).toMatch(/\.in\("status", \["em_aberto", "em_confirmacao"\]\)/);
  });

  it("so oferece re-acordo quando o saldo residual e confiavel", () => {
    // `acordo_saldo_residual` e a mesma fonte que a RPC usa para aceitar ou
    // recusar: residual nao confiavel nao vira opcao na tela.
    expect(CODIGO_SEM_COMENTARIO).toContain("acordo_saldo_residual");
    expect(CODIGO_SEM_COMENTARIO).toMatch(/\.confiavel/);
  });
});

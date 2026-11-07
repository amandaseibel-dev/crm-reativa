// Garantias deste módulo, em ordem de importância:
// 1. NADA de pessoal sai do recorte;
// 2. o corpo SSE é lido;
// 3. envelope com erro levanta em vez de devolver meia-verdade.
import { describe, it, expect } from "vitest";
import {
  ACCEPT_MCP,
  cargaDaFerramenta,
  lerCorpoMcp,
  recortarAcesso,
  recortarFerramentas,
  resultadoDoEnvelope,
} from "./diagnostico.ts";

const ACESSO_BRUTO = {
  pessoa: { nome: "Fulana de Tal", email: "fulana@exemplo.com", perfis: ["supervisor", "gestao"] },
  conexao: { tipo: "servico", nome: "Integração X" },
  escopos: ["clientes:read", "conversas:read"],
  limites: { pessoaPorDia: { limite: 500, restam: 462 } },
};

describe("recortarAcesso — superfície sem dado pessoal", () => {
  it("devolve tipo de conexão, perfis, escopos e limites", () => {
    expect(recortarAcesso(ACESSO_BRUTO)).toEqual({
      conexao_tipo: "servico",
      perfis: ["supervisor", "gestao"],
      escopos: ["clientes:read", "conversas:read"],
      limites: { pessoaPorDia: { limite: 500, restam: 462 } },
    });
  });

  it("NÃO deixa passar nome, e-mail nem o objeto pessoa", () => {
    const recorte = recortarAcesso(ACESSO_BRUTO);
    // `pessoa` sai inteiro; o que sobra com esse prefixo é nome de limite
    // (`pessoaPorDia`), que é orçamento, não identidade.
    expect(recorte).not.toHaveProperty("pessoa");
    const saida = JSON.stringify(recorte);
    expect(saida).not.toContain("Fulana");
    expect(saida).not.toContain("@");
    expect(saida).not.toContain("Integração X");
  });

  it("aguenta carga vazia ou com formato inesperado", () => {
    expect(recortarAcesso(null)).toEqual({ conexao_tipo: null, perfis: [], escopos: [], limites: {} });
    expect(recortarAcesso({ escopos: "nao-e-lista" })).toEqual({
      conexao_tipo: null, perfis: [], escopos: [], limites: {},
    });
  });
});

describe("recortarFerramentas", () => {
  it("devolve só os nomes, ordenados", () => {
    const r = recortarFerramentas({ tools: [{ name: "zeta", description: "x" }, { name: "alfa" }] });
    expect(r).toEqual(["alfa", "zeta"]);
  });
  it("ignora entradas sem nome e formato inesperado", () => {
    expect(recortarFerramentas({ tools: [{}, { name: 1 }, { name: "ok" }] })).toEqual(["ok"]);
    expect(recortarFerramentas({})).toEqual([]);
  });
});

describe("envelope e corpo", () => {
  const envelope = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a" }] } };

  it("lê corpo SSE", () => {
    const corpo = `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
    expect(lerCorpoMcp("text/event-stream", corpo)).toEqual(envelope);
  });

  it("lê corpo JSON direto", () => {
    expect(lerCorpoMcp("application/json", JSON.stringify(envelope))).toEqual(envelope);
  });

  it("devolve o result do envelope", () => {
    expect(resultadoDoEnvelope(envelope)).toEqual({ tools: [{ name: "a" }] });
  });

  it("levanta em erro do MCP, em isError e em envelope sem result", () => {
    expect(() => resultadoDoEnvelope({ error: { message: "x" } })).toThrow();
    expect(() => resultadoDoEnvelope({ result: { isError: true } })).toThrow();
    expect(() => resultadoDoEnvelope({ jsonrpc: "2.0" })).toThrow();
    expect(() => resultadoDoEnvelope(null)).toThrow();
  });

  it("extrai a carga de tools/call e levanta sem content", () => {
    expect(cargaDaFerramenta({ content: [{ text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(() => cargaDaFerramenta({})).toThrow();
  });

  it("ACCEPT_MCP declara os dois tipos", () => {
    expect(ACCEPT_MCP).toContain("application/json");
    expect(ACCEPT_MCP).toContain("text/event-stream");
  });
});

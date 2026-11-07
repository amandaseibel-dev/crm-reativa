// Contrato de listar_atendimentos (forma real de 2026-11-04) e cache da ficha.
import { describe, it, expect } from "vitest";
import { TTL_MS, criarCache, extrairResultado, montarChamada, recortar } from "./atendimento.ts";

const RESPOSTA_REAL = {
  atendimentos: [
    { id: "6ab18f359be689ab72d973ea", cliente: { id: "691dd4ad5dbe7b715b96c8ee", nome: "Cliente" }, situacao: "accepted", coluna: "contacted", equipe: "Reativa", atendente: "Luana Marques", entrouEm: "2026-09-21T20:10:29.891Z", aceitoEm: "2026-10-27T14:47:25.563Z", atualizadoEm: "2026-11-04T11:00:50.253Z" },
    { id: "antigo", cliente: { id: "691dd4ad5dbe7b715b96c8ee", nome: "Cliente" }, situacao: "done", coluna: null, equipe: "Reativa", atendente: null, entrouEm: "2026-07-01T00:00:00.000Z", aceitoEm: null, atualizadoEm: "2026-07-02T00:00:00.000Z" },
  ],
  paginacao: { pagina: 1, limite: 1, total: 2 },
  chamada: "6aeb119db0d037965ad8b583",
};

describe("ulbra-atendimento: pedido", () => {
  it("listar_atendimentos filtrado pelo cliente vinculado, limite 1", () => {
    const c = montarChamada("691dd4ad5dbe7b715b96c8ee");
    expect(c.params.name).toBe("listar_atendimentos");
    expect(c.params.arguments).toEqual({ cliente: "691dd4ad5dbe7b715b96c8ee", limite: 1 });
  });
});

describe("ulbra-atendimento: recorte", () => {
  it("pega o mais recente e só os campos da ficha", () => {
    expect(recortar(RESPOSTA_REAL)).toEqual({
      id: "6ab18f359be689ab72d973ea",
      situacao: "accepted",
      coluna: "contacted",
      equipe: "Reativa",
      atendente: "Luana Marques",
      entrou_em: "2026-09-21T20:10:29.891Z",
      atualizado_em: "2026-11-04T11:00:50.253Z",
    });
  });

  it("não devolve nome, contato nem id do cliente", () => {
    const r = recortar(RESPOSTA_REAL) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["atendente", "atualizado_em", "coluna", "entrou_em", "equipe", "id", "situacao"]);
  });

  it("sem atendimentos → null", () => {
    expect(recortar({ atendimentos: [] })).toBeNull();
    expect(recortar({})).toBeNull();
    expect(recortar(null)).toBeNull();
  });

  it("atualizado_em cai para aceitoEm e entrouEm", () => {
    expect(recortar({ atendimentos: [{ id: "x", aceitoEm: "A" }] })?.atualizado_em).toBe("A");
    expect(recortar({ atendimentos: [{ id: "x", entrouEm: "E" }] })?.atualizado_em).toBe("E");
  });

  it("envelope JSON-RPC: extrai texto e falha fechado com error", () => {
    const env = { result: { content: [{ type: "text", text: JSON.stringify(RESPOSTA_REAL) }] } };
    expect(recortar(extrairResultado(env))?.id).toBe("6ab18f359be689ab72d973ea");
    expect(() => extrairResultado({ error: { message: "limite" } })).toThrow(/MCP_ERRO/);
  });
});

describe("ulbra-atendimento: cache", () => {
  it("guarda inclusive 'sem atendimento' e expira após o TTL", () => {
    let t = 1000;
    const c = criarCache(() => t);
    expect(c.obter("k")).toBeUndefined();
    c.guardar("k", null);
    expect(c.obter("k")).toBeNull();
    t += TTL_MS - 1;
    expect(c.obter("k")).toBeNull();
    t += 1;
    expect(c.obter("k")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Leitura do corpo SSE do MCP. O enquadramento abaixo e o MEDIDO em
// 2026-11-07 contra crm.ulbra.ai/api/mcp: `event: message` + uma linha `data:`
// com o envelope JSON-RPC inteiro. Sem `Accept` o servidor devolve 406.
// ---------------------------------------------------------------------------
import { ACCEPT_MCP, lerCorpoMcp } from "./atendimento.ts";

describe("lerCorpoMcp — corpo SSE da Mensageria", () => {
  const envelope = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ text: '{"resultados":[]}' }] },
  };
  const sse = (e: unknown) => `event: message\ndata: ${JSON.stringify(e)}\n\n`;

  it("le o envelope do evento SSE", () => {
    expect(lerCorpoMcp("text/event-stream", sse(envelope))).toEqual(envelope);
  });

  it("aceita content-type com charset e caixa alta", () => {
    expect(lerCorpoMcp("TEXT/EVENT-STREAM; charset=utf-8", sse(envelope))).toEqual(envelope);
  });

  it("concatena varias linhas data: do mesmo evento", () => {
    const corpo = 'event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1}\n\n';
    expect(lerCorpoMcp("text/event-stream", corpo)).toEqual({ jsonrpc: "2.0", id: 1 });
  });

  it("pula comentario/keep-alive e usa o evento com payload", () => {
    expect(lerCorpoMcp("text/event-stream", `: ping\n\n${sse(envelope)}`)).toEqual(envelope);
  });

  it("entende CRLF", () => {
    const corpo = `event: message\r\ndata: ${JSON.stringify(envelope)}\r\n\r\n`;
    expect(lerCorpoMcp("text/event-stream", corpo)).toEqual(envelope);
  });

  it("falha FECHADO quando o corpo SSE nao tem data:", () => {
    expect(() => lerCorpoMcp("text/event-stream", "event: message\n\n")).toThrow();
  });

  it("corpo JSON direto continua funcionando, com e sem content-type", () => {
    expect(lerCorpoMcp("application/json", JSON.stringify(envelope))).toEqual(envelope);
    expect(lerCorpoMcp(null, JSON.stringify(envelope))).toEqual(envelope);
  });

  it("ACCEPT_MCP declara os dois tipos exigidos", () => {
    expect(ACCEPT_MCP).toContain("application/json");
    expect(ACCEPT_MCP).toContain("text/event-stream");
  });
});

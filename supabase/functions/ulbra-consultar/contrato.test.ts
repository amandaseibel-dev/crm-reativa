// Teste de contrato do MCP da Mensageria Ulbra: fixtures na FORMA real medida
// em 2026-11-04 (ids e nomes trocados). Se a Mensageria mudar a forma, este
// é o teste que deve quebrar — nunca o mock da tela.
import { describe, it, expect } from "vitest";
import { escolherContato, extrairResultado, interpretar, montarChamada } from "./mcp.ts";

function envelope(texto: unknown) {
  return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(texto) }] } };
}

const NO_ESCOPO_EM_ATENDIMENTO = {
  resultados: [
    { posicao: 0, existe: true, cliente: { id: "6a8353957e2e9cae71e8207f" }, equipe: "Reativa", emAtendimento: { equipe: "Reativa" } },
  ],
  chamada: "6aeb12c5b0d037965ad8cf55",
};

const EXISTE_SEM_ESCOPO_NEM_EQUIPE = {
  resultados: [{ posicao: 0, existe: true, equipe: null, emAtendimento: null }],
  chamada: "6aeb12c5b0d037965ad8cf56",
};

const FORA_DO_ESCOPO = {
  resultados: [{ posicao: 0, existe: true, equipe: "Financeiro", emAtendimento: null }],
};

const NAO_EXISTE = { resultados: [{ posicao: 0, existe: false }] };

describe("ulbra-consultar contrato: pedido", () => {
  it("conferir_duplicidade recebe contatos[] e não telefone solto", () => {
    const c = montarChamada({ telefone: "5551999990000" });
    expect(c.method).toBe("tools/call");
    expect(c.params.name).toBe("conferir_duplicidade");
    expect(c.params.arguments).toEqual({ contatos: [{ telefone: "5551999990000" }] });
    expect(c.params.arguments).not.toHaveProperty("telefone");
  });
});

describe("ulbra-consultar contrato: envelope JSON-RPC", () => {
  it("extrai o JSON de result.content[0].text", () => {
    expect(extrairResultado(envelope(NAO_EXISTE))).toEqual(NAO_EXISTE);
  });

  it("falha fechado com error no envelope", () => {
    expect(() => extrairResultado({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "limite" } })).toThrow(/MCP_ERRO/);
  });

  it("falha fechado sem conteúdo", () => {
    expect(() => extrairResultado({ result: {} })).toThrow(/ENVELOPE_SEM_CONTEUDO/);
    expect(() => extrairResultado(null)).toThrow(/ENVELOPE_INVALIDO/);
  });
});

describe("ulbra-consultar contrato: interpretação de resultados[]", () => {
  it("cliente no escopo → vinculado com equipe e atendimento", () => {
    expect(interpretar(NO_ESCOPO_EM_ATENDIMENTO)).toEqual({
      status: "vinculado",
      ulbra_cliente_id: "6a8353957e2e9cae71e8207f",
      equipe: "Reativa",
      em_atendimento: true,
    });
  });

  it("existe:true sem cliente nem equipe (telefone inexistente) → NAO_ENCONTRADO", () => {
    expect(interpretar(EXISTE_SEM_ESCOPO_NEM_EQUIPE)).toEqual({ status: "nao_encontrado", motivo: "NAO_ENCONTRADO" });
  });

  it("existe em outra equipe, sem cliente.id → FORA_DO_ESCOPO", () => {
    expect(interpretar(FORA_DO_ESCOPO)).toEqual({ status: "nao_encontrado", motivo: "FORA_DO_ESCOPO" });
  });

  it("existe:false → NAO_ENCONTRADO", () => {
    expect(interpretar(NAO_EXISTE)).toEqual({ status: "nao_encontrado", motivo: "NAO_ENCONTRADO" });
  });

  it("forma antiga (clientes[]) não é mais aceita: vira RESPOSTA_INVALIDA", () => {
    expect(interpretar({ clientes: [{ id: "x", equipe: "Reativa" }] })).toEqual({ status: "erro", motivo: "RESPOSTA_INVALIDA" });
    expect(interpretar(null)).toEqual({ status: "erro", motivo: "RESPOSTA_INVALIDA" });
  });

  it("nunca devolve telefone ou CPF", () => {
    const r = interpretar(NO_ESCOPO_EM_ATENDIMENTO) as Record<string, unknown>;
    expect(r).not.toHaveProperty("telefone");
    expect(r).not.toHaveProperty("cpf");
  });
});

describe("ulbra-consultar contrato: escolha do contato", () => {
  it("prefere telefone válido e normaliza E.164", () => {
    expect(escolherContato({ telefone: "(51) 99999-0000", cpf: "12345678901" })).toEqual({
      contato: { telefone: "51999990000" }, origem: "telefone", telefone_e164: "+5551999990000",
    });
  });

  it("telefone já com 55 não duplica o DDI no E.164", () => {
    const r = escolherContato({ telefone: "5551999990000" });
    expect("contato" in r && r.telefone_e164).toBe("+5551999990000");
  });

  it("sem telefone usa CPF como fallback", () => {
    expect(escolherContato({ telefone: null, cpf: "123.456.789-01" })).toEqual({
      contato: { cpf: "12345678901" }, origem: "cpf", telefone_e164: null,
    });
  });

  it("telefone curto e sem CPF → TELEFONE_MALFORMADO; nada → SEM_TELEFONE", () => {
    expect(escolherContato({ telefone: "9999", cpf: null })).toEqual({ erro: "TELEFONE_MALFORMADO" });
    expect(escolherContato({ telefone: "", cpf: "" })).toEqual({ erro: "SEM_TELEFONE" });
  });
});

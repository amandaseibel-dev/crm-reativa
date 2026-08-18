import { describe, it, expect } from "vitest";
import { normalizarE164, formatarTelefone } from "./telefone";

describe("normalizarE164", () => {
  it("aceita celular com 11 digitos e poe o DDI", () => {
    expect(normalizarE164("51999998888")).toBe("5551999998888");
  });

  it("aceita fixo com 10 digitos", () => {
    expect(normalizarE164("5133334444")).toBe("555133334444");
  });

  it("mantem quem ja veio com DDI", () => {
    expect(normalizarE164("5551999998888")).toBe("5551999998888");
    expect(normalizarE164("555133334444")).toBe("555133334444");
  });

  it("limpa mascara, espaco e +", () => {
    expect(normalizarE164("+55 (51) 99999-8888")).toBe("5551999998888");
  });

  it("o mesmo numero em formatos diferentes vira a MESMA chave de conversa", () => {
    // e isto que impede abrir duas conversas para a mesma pessoa
    expect(normalizarE164("+55 (51) 99999-8888")).toBe(normalizarE164("51999998888"));
  });

  it("nao mexe em numero estrangeiro", () => {
    expect(normalizarE164("351912345678")).toBe("351912345678");
  });

  it("descarta o que nao da para aproveitar", () => {
    expect(normalizarE164("")).toBe("");
    expect(normalizarE164(null)).toBe("");
    expect(normalizarE164("99998888")).toBe("");
    expect(normalizarE164("nao e telefone")).toBe("");
  });
});

describe("formatarTelefone", () => {
  it("formata celular", () => {
    expect(formatarTelefone("5551999998888")).toBe("+55 (51) 99999-8888");
  });

  it("formata fixo", () => {
    expect(formatarTelefone("555133334444")).toBe("+55 (51) 3333-4444");
  });

  it("devolve o original quando nao reconhece", () => {
    expect(formatarTelefone("123")).toBe("123");
  });
});

import { describe, it, expect } from "vitest";
import {
  normalizarE164,
  formatarTelefone,
  normalizarCadastro,
  formatarCadastro,
} from "./telefone";

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

describe("normalizarCadastro / formatarCadastro", () => {
  it("tira o DDD duplicado do cadastro (caso real da ficha)", () => {
    // "(51) (51) 8110-4056" -- 2.735 alunos em prod estavam assim
    expect(normalizarCadastro("(51) (51) 8110-4056")).toBe("5551981104056");
  });

  it("tira o DDD duplicado quando ja tem o 9o digito", () => {
    expect(normalizarCadastro("(64) (64) 98122-6896")).toBe("5564981226896");
  });

  it("completa o 9o digito de celular antigo", () => {
    expect(normalizarCadastro("(51) 8110-4056")).toBe("5551981104056");
  });

  it("nao mexe em numero que ja esta certo", () => {
    expect(normalizarCadastro("+55 (51) 99999-8888")).toBe("5551999998888");
    expect(normalizarCadastro("51999998888")).toBe("5551999998888");
  });

  it("DDD 55 (Santa Maria) sobrevive: 55 na frente e depois o DDD", () => {
    expect(normalizarCadastro("(55) 99035-2359")).toBe("5555990352359");
    // e o formato ja duplicado da no MESMO lugar
    expect(normalizarCadastro("5555990352359")).toBe("5555990352359");
  });

  it("exibe com o 55 na frente e o DDD depois", () => {
    expect(formatarCadastro("(51) (51) 8110-4056")).toBe("+55 (51) 98110-4056");
  });

  it("telefone vazio nao vira texto quebrado", () => {
    expect(formatarCadastro("")).toBe("");
    expect(formatarCadastro(null)).toBe("");
  });
});

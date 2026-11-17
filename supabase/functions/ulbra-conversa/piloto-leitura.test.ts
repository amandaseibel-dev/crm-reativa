import { describe, it, expect } from "vitest";
import { pilotoPermiteLeitura } from "./piloto-leitura.ts";

describe("restrição de piloto da leitura", () => {
  it("lista vazia, ausente ou só espaços: ninguém lê (fail-closed)", () => {
    expect(pilotoPermiteLeitura("cobranca10@aelbra.com.br", undefined)).toBe(false);
    expect(pilotoPermiteLeitura("cobranca10@aelbra.com.br", null)).toBe(false);
    expect(pilotoPermiteLeitura("cobranca10@aelbra.com.br", "")).toBe(false);
    expect(pilotoPermiteLeitura("cobranca10@aelbra.com.br", "   ")).toBe(false);
  });

  it("só quem está na lista lê; os demais não, mesmo com carteira ou responsabilidade", () => {
    const lista = "cobranca10@aelbra.com.br";
    expect(pilotoPermiteLeitura("cobranca10@aelbra.com.br", lista)).toBe(true);
    expect(pilotoPermiteLeitura("cobranca07@aelbra.com.br", lista)).toBe(false);
    expect(pilotoPermiteLeitura("amanda.seibel@aelbra.com.br", lista)).toBe(false);
  });

  it("compara sem diferenciar maiúsculas e aceita mais de um e-mail na lista", () => {
    const lista = " Cobranca10@aelbra.com.br , outra@aelbra.com.br ";
    expect(pilotoPermiteLeitura("COBRANCA10@aelbra.com.br", lista)).toBe(true);
    expect(pilotoPermiteLeitura("outra@aelbra.com.br", lista)).toBe(true);
  });

  it("nome parcial ou e-mail parecido não passa", () => {
    expect(pilotoPermiteLeitura("cobranca1@aelbra.com.br", "cobranca10@aelbra.com.br")).toBe(false);
    expect(pilotoPermiteLeitura("cobranca10@aelbra.com", "cobranca10@aelbra.com.br")).toBe(false);
  });
});

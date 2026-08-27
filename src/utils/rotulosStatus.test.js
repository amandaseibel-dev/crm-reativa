import { describe, it, expect } from "vitest";
import { rotuloStatus, rotuloStatusComSaldo } from "./rotulosStatus";

describe("rotuloStatus", () => {
  it("troca o enum do banco por texto de gente", () => {
    expect(rotuloStatus("EM_ABERTO")).toBe("Em cobrança");
    expect(rotuloStatus("TERMO_RECEBIDO_LIBERADO")).toBe("Termo liberado");
    expect(rotuloStatus("LINK_PRONTO_PARA_ENVIO")).toBe("Link pronto p/ envio");
  });

  it("status desconhecido nao vaza em CAIXA_ALTA", () => {
    expect(rotuloStatus("ALGUM_STATUS_NOVO")).toBe("Algum status novo");
  });

  it("nao mexe em texto que ja e humano", () => {
    expect(rotuloStatus("A contatar")).toBe("A contatar");
  });

  it("vazio continua vazio", () => {
    expect(rotuloStatus("")).toBe("");
    expect(rotuloStatus(null)).toBe("");
  });
});

describe("rotuloStatusComSaldo — a armadilha do 'Pago'", () => {
  it("so diz Pago com saldo comprovadamente zerado", () => {
    expect(rotuloStatusComSaldo("BAIXA_REALIZADA", true)).toBe("Pago");
  });

  it("com saldo em aberto NAO diz Pago", () => {
    expect(rotuloStatusComSaldo("BAIXA_REALIZADA", false)).toBe("Baixa realizada");
  });

  it("saldo desconhecido NAO diz Pago", () => {
    expect(rotuloStatusComSaldo("BAIXA_REALIZADA", null)).toBe("Baixa realizada");
    expect(rotuloStatusComSaldo("BAIXA_REALIZADA", undefined)).toBe("Baixa realizada");
  });
});

import { describe, it, expect } from "vitest";
import { naoReabreNoBordero, SITUACOES_QUE_NAO_REABREM } from "./bordero";

describe("borderô não reabre título terminal", () => {
  it("CANCELADA (encerramento administrativo) nunca reabre, como PAGO e EM_CONFIRMACAO", () => {
    expect(naoReabreNoBordero("CANCELADA")).toBe(true);
    expect(naoReabreNoBordero("cancelada")).toBe(true);
    expect(naoReabreNoBordero("PAGO")).toBe(true);
    expect(naoReabreNoBordero("EM_CONFIRMACAO")).toBe(true);
  });
  it("ABERTO, NEGOCIADO, DUPLICADA e título novo seguem o fluxo normal do borderô", () => {
    expect(naoReabreNoBordero("ABERTO")).toBe(false);
    expect(naoReabreNoBordero("NEGOCIADO")).toBe(false);
    expect(naoReabreNoBordero("DUPLICADA")).toBe(false);
    expect(naoReabreNoBordero(null)).toBe(false);
    expect(SITUACOES_QUE_NAO_REABREM).toContain("CANCELADA");
  });
});

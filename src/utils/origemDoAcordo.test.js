import { describe, it, expect } from "vitest";
import { origemDoAcordo } from "./origemDoAcordo";

const mensalidade = (documento, acordo_id) => ({
  acordo_id, documento, tipo_boleto: "Cursos de Graduação Presencial",
});
const boletoDeAcordo = (documento, acordo_id) => ({
  acordo_id, documento, tipo_boleto: "Acordo",
});

describe("origem do acordo", () => {
  it("acordo que veio de mensalidade lista os numeros dos titulos", () => {
    const r = origemDoAcordo([
      mensalidade("3957649", "a1"),
      mensalidade("3957650", "a1"),
    ], "a1");
    expect(r.mensalidades).toEqual(["3957649", "3957650"]);
    expect(r.renegociacoes).toEqual([]);
    expect(r.semOrigem).toBe(false);
  });

  it("RENEGOCIACAO nao pode ser lida como sem origem -- era o furo", () => {
    // Este e o caso que o gatilho de titulos_origem descarta: o unico titulo
    // vinculado e o boleto do acordo anterior.
    const r = origemDoAcordo([boletoDeAcordo("4400001", "a1")], "a1");
    expect(r.renegociacoes).toEqual(["4400001"]);
    expect(r.mensalidades).toEqual([]);
    expect(r.semOrigem).toBe(false);
  });

  it("acordo sem vinculo nenhum e sem origem, e isso e informacao", () => {
    const r = origemDoAcordo([mensalidade("3957649", "OUTRO")], "a1");
    expect(r.semOrigem).toBe(true);
  });

  it("acordo misto separa mensalidade de renegociacao", () => {
    const r = origemDoAcordo([
      mensalidade("3957649", "a1"),
      boletoDeAcordo("4400001", "a1"),
    ], "a1");
    expect(r.mensalidades).toEqual(["3957649"]);
    expect(r.renegociacoes).toEqual(["4400001"]);
    expect(r.semOrigem).toBe(false);
  });

  it("titulo sem documento nao vira linha vazia na tela", () => {
    const r = origemDoAcordo([
      { acordo_id: "a1", documento: null, tipo_boleto: "Mensalidade" },
      { acordo_id: "a1", documento: "   ", tipo_boleto: "Mensalidade" },
    ], "a1");
    expect(r.mensalidades).toEqual([]);
    expect(r.semOrigem).toBe(true);
  });

  it("aguenta lista vazia ou ausente sem quebrar a ficha", () => {
    expect(origemDoAcordo([], "a1").semOrigem).toBe(true);
    expect(origemDoAcordo(null, "a1").semOrigem).toBe(true);
    expect(origemDoAcordo([null, undefined], "a1").semOrigem).toBe(true);
  });

  it("numero vindo como numero (nao texto) continua aparecendo", () => {
    const r = origemDoAcordo([{ acordo_id: "a1", documento: 3957649, tipo_boleto: "X" }], "a1");
    expect(r.mensalidades).toEqual(["3957649"]);
  });
});

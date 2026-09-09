import { describe, it, expect } from "vitest";
import { origemDoAcordo } from "./origemDoAcordo";

const mensalidade = (documento, acordo_id, extra = {}) => ({
  acordo_id, documento, tipo_boleto: "Cursos de Graduação Presencial", ...extra,
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

  describe("composição — o que o acordo substituiu", () => {
    it("lista cada mensalidade com vencimento e valor, e soma o total", () => {
      const r = origemDoAcordo([
        mensalidade("3957650", "a1", { vencimento: "2026-05-10", valor_original: 300 }),
        mensalidade("3957649", "a1", { vencimento: "2026-04-10", valor_original: 250.5 }),
      ], "a1");

      expect(r.itensMensalidade).toHaveLength(2);
      expect(r.totalMensalidade).toBeCloseTo(550.5, 2);
    });

    it("ordena do vencimento mais antigo para o mais novo", () => {
      const r = origemDoAcordo([
        mensalidade("B", "a1", { vencimento: "2026-06-10" }),
        mensalidade("A", "a1", { vencimento: "2026-01-10" }),
        mensalidade("C", "a1", { vencimento: "2026-09-10" }),
      ], "a1");
      expect(r.itensMensalidade.map((t) => t.documento)).toEqual(["A", "B", "C"]);
    });

    it("usa valor_original -- e nao o saldo, que muda depois do acordo", () => {
      const r = origemDoAcordo([
        mensalidade("X", "a1", { valor_original: 400, saldo_corrigido: 90, valor_em_aberto: 0 }),
      ], "a1");
      expect(r.totalMensalidade).toBe(400);
    });

    it("cai para o saldo quando nao ha valor original", () => {
      const r = origemDoAcordo([
        mensalidade("X", "a1", { valor_original: null, saldo_corrigido: 90 }),
      ], "a1");
      expect(r.totalMensalidade).toBe(90);
    });

    it("separa o total da renegociacao do total de mensalidade", () => {
      const r = origemDoAcordo([
        mensalidade("A", "a1", { valor_original: 100 }),
        boletoDeAcordo("Z", "a1"),
      ], "a1");
      expect(r.totalMensalidade).toBe(100);
      expect(r.itensRenegociacao.map((t) => t.documento)).toEqual(["Z"]);
    });

    it("valor invalido nao contamina o total", () => {
      const r = origemDoAcordo([
        mensalidade("A", "a1", { valor_original: "não é número" }),
        mensalidade("B", "a1", { valor_original: 50 }),
      ], "a1");
      expect(r.totalMensalidade).toBe(50);
    });
  });
});

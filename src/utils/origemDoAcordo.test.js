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

// ACORDO CANCELADO: o cancelamento zera acordos_titulos.acordo_id para a
// mensalidade voltar a ser cobrada. A composição do acordo não pode sumir junto
// -- é justamente quando alguém precisa ver o que o acordo tinha dentro.
describe("acordo cancelado", () => {
  const titulo = {
    id: "t1", acordo_id: null, documento: "4266474",
    vencimento: "2026-04-05", valor_original: 462.93, tipo_boleto: "Mensalidade",
    situacao: "ABERTO",
  };

  it("sem o historico, a composicao do acordo cancelado fica vazia", () => {
    const r = origemDoAcordo([titulo], "a1");
    expect(r.semOrigem).toBe(true);
  });

  it("com o historico do vinculo, a composicao continua aparecendo", () => {
    const r = origemDoAcordo([titulo], "a1", [{ titulo_id: "t1", acordo_id: "a1" }]);
    expect(r.semOrigem).toBe(false);
    expect(r.itensMensalidade).toHaveLength(1);
    expect(r.itensMensalidade[0].documento).toBe("4266474");
  });

  it("marca que a mensalidade voltou a ser cobrada", () => {
    const r = origemDoAcordo([titulo], "a1", [{ titulo_id: "t1", acordo_id: "a1" }]);
    expect(r.itensMensalidade[0].voltouACobrar).toBe(true);
  });

  it("titulo ainda vinculado nao aparece como voltou a cobrar", () => {
    const vivo = { ...titulo, acordo_id: "a1", situacao: "NEGOCIADO" };
    const r = origemDoAcordo([vivo], "a1", [{ titulo_id: "t1", acordo_id: "a1" }]);
    expect(r.itensMensalidade[0].voltouACobrar).toBe(false);
  });

  it("o historico de OUTRO acordo nao contamina este", () => {
    const r = origemDoAcordo([titulo], "a1", [{ titulo_id: "t1", acordo_id: "a2" }]);
    expect(r.semOrigem).toBe(true);
  });

  it("nao duplica quando o titulo esta ligado e tambem no historico", () => {
    const vivo = { ...titulo, acordo_id: "a1" };
    const r = origemDoAcordo([vivo], "a1", [{ titulo_id: "t1", acordo_id: "a1" }]);
    expect(r.itensMensalidade).toHaveLength(1);
  });
});

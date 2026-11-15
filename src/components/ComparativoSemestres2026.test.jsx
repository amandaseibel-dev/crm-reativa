import { describe, it, expect } from "vitest";
import { montarLinhasSemestres } from "./ComparativoSemestres2026";

const fotografia2026_1 = {
  gerado_em: "2026-10-29T13:10:00Z",
  snapshot: { atualizacao_pendente: true },
  situacoes: {
    entrou: { valor: 21710447.29 },
    em_aberto: { valor: 9055032.58 },
    negociado: { valor: 4535961.61 },
    pago: { valor: 6219804.34 },
  },
};
const contexto2026_2 = { carteira_valor: 17232872.41, atualizado_em: "2026-11-15T20:22:58Z" };
const negociacoes2026_2 = { total: { saldo: 245326.06, negociado: 1232903.01, recebido: 987576.95 } };
const caixa = {
  "2026/1": { caixa_confirmado: 535206.14, pagamentos_confirmados: 639,
              pendente_classificacao: 3314532.12, pagamentos_pendentes: 1340, data_referencia: "2026-11-13" },
  "2026/2": { caixa_confirmado: 653066.80, pagamentos_confirmados: 594,
              pendente_classificacao: 120444.29, pagamentos_pendentes: 84, data_referencia: "2026-11-13" },
};

describe("montarLinhasSemestres", () => {
  const [l1, l2] = montarLinhasSemestres({ fotografia2026_1, contexto2026_2, negociacoes2026_2, caixa });

  it("2026/1 usa a carteira e o saldo totais da fotografia", () => {
    expect(l1.carteira).toBe(21710447.29);
    expect(l1.saldoAberto).toBe(9055032.58);
  });

  it("2026/2 NÃO apresenta saldo total: o saldo de R$ 245 mil é só dos acordos", () => {
    expect(l2.saldoAberto).toBeNull();
    expect(l2.saldoAcordos).toBe(245326.06);
    expect(l2.saldoAcordos).not.toBe(l2.carteira);
  });

  it("caixa confirmado vem do critério PROVADA+BAIXADO, não do rateio", () => {
    expect(l1.caixa).toBe(535206.14);
    expect(l2.caixa).toBe(653066.80);
    expect(l1.caixa).not.toBe(l1.rateio);
    expect(l2.caixa).not.toBe(l2.rateio);
  });

  it("rateio fica separado e não é tratado como negociado nem caixa", () => {
    expect(l1.rateio).toBe(6219804.34);
    expect(l2.rateio).toBe(987576.95);
    expect(l2.negociado).toBe(1232903.01);
  });

  it("pendente de classificação fica fora do caixa, com contagem", () => {
    expect(l1.pendente).toBe(3314532.12);
    expect(l1.pendentes).toBe(1340);
    expect(l2.pendente).toBe(120444.29);
  });

  it("dado ausente vira null, nunca zero", () => {
    const [semFoto] = montarLinhasSemestres({ fotografia2026_1: null, contexto2026_2: null,
                                             negociacoes2026_2: null, caixa: null });
    expect(semFoto.carteira).toBeNull();
    expect(semFoto.caixa).toBeNull();
    expect(semFoto.saldoAberto).toBeNull();
  });

  it("sinaliza fotografia de 2026/1 com atualização pendente", () => {
    expect(l1.atualizacaoPendente).toBe(true);
    expect(l2.atualizacaoPendente).toBe(false);
  });
});

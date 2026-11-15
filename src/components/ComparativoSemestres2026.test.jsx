import { describe, it, expect } from "vitest";
import { montarLinhasSemestres } from "./ComparativoSemestres2026";

// Números medidos em produção em 15/11/2026 (leitura). 2026/2 vem do classificador oficial.
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
const negociacoes2026_2 = { total: { negociado: 1232903.01, recebido: 987576.95, saldo: 245326.06 } };
const caixa = {
  "2026/1": { caixa_confirmado: 535206.14, pagamentos_confirmados: 639,
              pendente_classificacao: 3314532.12, pagamentos_pendentes: 1340, data_referencia: "2026-11-13" },
  "2026/2": { caixa_confirmado: 653066.80, pagamentos_confirmados: 594,
              pendente_classificacao: 120444.29, pagamentos_pendentes: 84, data_referencia: "2026-11-13",
              saldo_2026_2: { carteira_original: 17232872.41, titulos_carteira: 10822,
                saldo_em_aberto_total: 16042642.07, saldo_em_conferencia: 7232872.33,
                saldo_academico: 111923.90, saldo_sem_pendencia: 8697845.84,
                saldo_acordos_ativos: 239654.71 } },
};

describe("montarLinhasSemestres", () => {
  const [l1, l2] = montarLinhasSemestres({ fotografia2026_1, negociacoes2026_2, caixa });

  it("2026/2: carteira e saldo total vêm do classificador, no mesmo recorte", () => {
    expect(l2.carteira).toBe(17232872.41);
    expect(l2.saldoAberto).toBe(16042642.07);
    expect(l2.saldoConferencia).toBe(7232872.33);
  });

  it("2026/2: o saldo dos acordos ativos é só uma parte, nunca o total", () => {
    expect(l2.saldoAcordosAtivos).toBe(239654.71);
    expect(l2.saldoAberto).not.toBe(l2.saldoAcordosAtivos);
    expect(l2.saldoAberto).not.toBe(245326.06);
  });

  it("2026/1 usa a carteira e o saldo da fotografia", () => {
    expect(l1.carteira).toBe(21710447.29);
    expect(l1.saldoAberto).toBe(9055032.58);
  });

  it("caixa confirmado vem do critério PROVADA+BAIXADO, nunca do rateio", () => {
    expect(l1.caixa).toBe(535206.14);
    expect(l2.caixa).toBe(653066.80);
    expect(l1.caixa).not.toBe(l1.rateio);
    expect(l2.caixa).not.toBe(l2.rateio);
  });

  it("rateio fica separado e negociado não é tratado como recebido", () => {
    expect(l1.rateio).toBe(6219804.34);
    expect(l2.rateio).toBe(987576.95);
    expect(l2.negociado).toBe(1232903.01);
  });

  it("pendente de classificação fica fora do caixa, com contagem", () => {
    expect(l1.pendente).toBe(3314532.12);
    expect(l1.pendentes).toBe(1340);
    expect(l2.pendente).toBe(120444.29);
    expect(l2.pendentes).toBe(84);
  });

  it("dado ausente vira null, nunca zero", () => {
    const [semFoto, semSaldo] = montarLinhasSemestres({ fotografia2026_1: null, negociacoes2026_2: null, caixa: null });
    expect(semFoto.carteira).toBeNull();
    expect(semFoto.caixa).toBeNull();
    expect(semFoto.saldoAberto).toBeNull();
    expect(semSaldo.saldoAberto).toBeNull();
    expect(semSaldo.carteira).toBeNull();
  });

  it("sinaliza fotografia de 2026/1 com atualização pendente", () => {
    expect(l1.atualizacaoPendente).toBe(true);
    expect(l2.atualizacaoPendente).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { montarLinhasSemestres } from "./ComparativoSemestres2026";

// Números medidos em produção (leitura) em 15/11/2026. Ver docs/seguranca/medicao-caixa-resumo-2026-11-15.md.
// A RPC já entrega carteira, títulos e percentual: a tela só lê esses campos.
const fotografia2026_1 = {
  gerado_em: "2026-10-29T13:10:00Z",
  snapshot: { atualizacao_pendente: true },
  situacoes: {
    em_aberto: { valor: 9055032.58 },
    negociado: { valor: 4535961.61 },
    pago: { valor: 6219804.34 },
  },
};
const negociacoes2026_2 = { total: { negociado: 1232903.01, recebido: 987576.95 } };
const caixa = {
  "2026/1": { caixa_confirmado: 535206.14, pagamentos_confirmados: 639,
              pendente_classificacao: 3314532.12, pagamentos_pendentes: 1340,
              carteira_original: 21710447.29, titulos_carteira: 14979,
              percentual_recuperado_caixa: 2.5 },
  "2026/2": { caixa_confirmado: 653066.80, pagamentos_confirmados: 594,
              pendente_classificacao: 120444.29, pagamentos_pendentes: 84,
              carteira_original: 17232872.41, titulos_carteira: 10822,
              percentual_recuperado_caixa: 3.8,
              saldo_2026_2: { saldo_em_aberto_total: 16042642.07, saldo_em_conferencia: 7232872.33 } },
};

describe("montarLinhasSemestres (só exibe o que a RPC entrega)", () => {
  const [l1, l2] = montarLinhasSemestres({ fotografia2026_1, negociacoes2026_2, caixa });

  it("2026/2: carteira, títulos e saldo total vêm do classificador", () => {
    expect(l2.carteira).toBe(17232872.41);
    expect(l2.titulos).toBe(10822);
    expect(l2.saldoAberto).toBe(16042642.07);
    expect(l2.saldoConferencia).toBe(7232872.33);
  });

  it("percentual vem pronto da RPC, sem cálculo na tela", () => {
    expect(l1.percentual).toBe(2.5);
    expect(l2.percentual).toBe(3.8);
  });

  it("2026/1: carteira vem da RPC e saldo da fotografia", () => {
    expect(l1.carteira).toBe(21710447.29);
    expect(l1.titulos).toBe(14979);
    expect(l1.saldoAberto).toBe(9055032.58);
  });

  it("caixa confirmado é o critério PROVADA+BAIXADO, nunca o rateio", () => {
    expect(l1.caixa).toBe(535206.14);
    expect(l2.caixa).toBe(653066.80);
    expect(l1.caixa).not.toBe(l1.rateio);
    expect(l2.caixa).not.toBe(l2.rateio);
  });

  it("rateio fica separado e negociado não vira recebido", () => {
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
    expect(semFoto.percentual).toBeNull();
    expect(semSaldo.saldoAberto).toBeNull();
    expect(semSaldo.carteira).toBeNull();
  });

  it("sinaliza fotografia de 2026/1 com atualização pendente", () => {
    expect(l1.atualizacaoPendente).toBe(true);
    expect(l2.atualizacaoPendente).toBe(false);
  });
});

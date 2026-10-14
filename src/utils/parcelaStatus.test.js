// O espelho de `public.parcela_viva()` no front. O risco que este teste cobre
// não é "a função funciona": é a REGRA SE PERDER entre o banco e a tela --
// parcela sair do saldo no banco e continuar somando como aberta na ficha.
import { describe, it, expect } from "vitest";
import { parcelaViva, parcelaPaga, parcelaSemPagamento, rotuloParcela } from "./parcelaStatus";

describe("parcelaViva — espelho de public.parcela_viva()", () => {
  it("cobrável: só o que de fato ainda se cobra", () => {
    expect(parcelaViva("A_VENCER")).toBe(true);
    expect(parcelaViva("VENCIDA")).toBe(true);
  });

  it("fora do cobrável: pagamento, cancelamento, estorno", () => {
    for (const s of ["PAGO", "PAGA", "CANCELADA", "CANCELADO", "ESTORNADA", "ESTORNADO"]) {
      expect(parcelaViva(s), s).toBe(false);
    }
  });

  it("fora do cobrável: DEVOLVIDA e SUSPENSA — o ponto da regra", () => {
    expect(parcelaViva("DEVOLVIDA")).toBe(false);
    expect(parcelaViva("SUSPENSA")).toBe(false);
  });

  it("RENEGOCIADA segue cobrável — a divergência do banco foi preservada", () => {
    // 6 parcelas reais em produção; mudar isso é decisão de negócio separada.
    expect(parcelaViva("RENEGOCIADA")).toBe(true);
  });

  it("falha para o lado seguro: desconhecido, nulo e vazio continuam cobráveis", () => {
    expect(parcelaViva("DEVOLVIDO_TYPO")).toBe(true);
    expect(parcelaViva(null)).toBe(true);
    expect(parcelaViva(undefined)).toBe(true);
    expect(parcelaViva("")).toBe(true);
  });

  it("não depende de caixa nem de espaço em volta", () => {
    expect(parcelaViva("devolvida")).toBe(false);
    expect(parcelaViva("  Suspensa  ")).toBe(false);
    expect(parcelaViva(" pago ")).toBe(false);
  });
});

describe("as três perguntas não se confundem", () => {
  it("devolvida saiu do cobrável mas NÃO é paga", () => {
    expect(parcelaViva("DEVOLVIDA")).toBe(false);
    expect(parcelaPaga("DEVOLVIDA")).toBe(false);
    expect(parcelaSemPagamento("DEVOLVIDA")).toBe(true);
  });

  it("suspensa idem", () => {
    expect(parcelaPaga("SUSPENSA")).toBe(false);
    expect(parcelaSemPagamento("SUSPENSA")).toBe(true);
  });

  it("paga é paga, e não é 'sem pagamento'", () => {
    expect(parcelaPaga("PAGO")).toBe(true);
    expect(parcelaSemPagamento("PAGO")).toBe(false);
  });

  it("cancelada saiu do cobrável, mas não é o efeito novo", () => {
    expect(parcelaViva("CANCELADA")).toBe(false);
    expect(parcelaSemPagamento("CANCELADA")).toBe(false);
  });
});

describe("rótulo", () => {
  it("DEVOLVIDA e SUSPENSA dizem na tela que não houve pagamento", () => {
    expect(rotuloParcela("DEVOLVIDA")).toMatch(/sem pagamento/i);
    expect(rotuloParcela("SUSPENSA")).toMatch(/sem pagamento/i);
  });

  it("nenhum dos dois pode ser rotulado como paga", () => {
    expect(rotuloParcela("DEVOLVIDA")).not.toMatch(/^Paga/);
    expect(rotuloParcela("SUSPENSA")).not.toMatch(/^Paga/);
  });

  it("status desconhecido volta como veio, sem inventar rótulo", () => {
    expect(rotuloParcela("COISA_NOVA")).toBe("COISA_NOVA");
    expect(rotuloParcela(null)).toBe("");
  });
});

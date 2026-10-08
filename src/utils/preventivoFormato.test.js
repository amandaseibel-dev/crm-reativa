// O BUG DO FUSO. `datetime-local` fala hora LOCAL; `toISOString()` devolve UTC.
// Em Brasília (UTC-3) isso empurrava o campo 3 horas para a frente — e, à
// noite, mudava o DIA, que é justamente o que ordena as remessas.
import { describe, it, expect } from "vitest";
import { agoraLocalParaInput, pct, moedaEm } from "./preventivoFormato";

describe("data inicial do campo de extração", () => {
  it("devolve a hora LOCAL, não a UTC", () => {
    // 21:30 local — em UTC-3 isso é 00:30 do dia seguinte em UTC
    const d = new Date(2026, 9, 6, 21, 30, 0);
    expect(agoraLocalParaInput(d)).toBe("2026-10-06T21:30");
  });

  it("não vira o dia à noite", () => {
    const d = new Date(2026, 9, 6, 23, 59, 0);
    const local = agoraLocalParaInput(d);
    expect(local.slice(0, 10)).toBe("2026-10-06");
    // é exatamente onde o toISOString errava em UTC-3
    if (d.getTimezoneOffset() > 0) {
      expect(d.toISOString().slice(0, 10)).not.toBe(local.slice(0, 10));
    }
  });

  it("preenche com zero à esquerda", () => {
    expect(agoraLocalParaInput(new Date(2026, 0, 2, 3, 4, 0))).toBe("2026-01-02T03:04");
  });

  it("o valor volta ao instante certo quando reconvertido", () => {
    const d = new Date(2026, 9, 6, 21, 30, 0);
    expect(new Date(agoraLocalParaInput(d)).getTime()).toBe(d.getTime());
  });
});

// A tela mostra "R$ 4.248.050,67 · 17,4%" na mesma linha: o separador decimal
// precisa ser o mesmo nos dois.
describe("percentual em pt-BR", () => {
  it("usa vírgula decimal e sempre uma casa", () => {
    expect(pct(17.4)).toBe("17,4%");
    expect(pct(60)).toBe("60,0%");
    expect(pct("55.7")).toBe("55,7%");
  });

  it("zero é zero, e não vira travessão", () => {
    expect(pct(0)).toBe("0,0%");
  });

  it("sem número não inventa valor", () => {
    expect(pct(null)).toBe("—");
    expect(pct(undefined)).toBe("—");
    expect(pct("")).toBe("—");
    expect(pct("tanto faz")).toBe("—");
  });

  it("separa milhar quando passa de cem", () => {
    expect(pct(1234.5)).toBe("1.234,5%");
  });
});

// O custo do WhatsApp de 05/10 foi pago em dólar. Escrever "R$" nele seria
// afirmar um fato falso sobre dinheiro.
describe("dinheiro com moeda declarada", () => {
  it("usa o símbolo de cada moeda", () => {
    expect(moedaEm(595.38, "USD")).toBe("US$ 595,38");
    expect(moedaEm(120.5, "BRL")).toBe("R$ 120,50");
  });

  it("moeda não informada NÃO vira real: sai sem símbolo", () => {
    expect(moedaEm(33, null)).toBe("33,00");
    expect(moedaEm(33, undefined)).toBe("33,00");
  });

  it("zero é zero, e ausência de valor é travessão", () => {
    expect(moedaEm(0, "USD")).toBe("US$ 0,00");
    expect(moedaEm(null, "USD")).toBe("—");
  });

  it("separa milhar em pt-BR", () => {
    expect(moedaEm(1234567.8, "USD")).toBe("US$ 1.234.567,80");
  });
});

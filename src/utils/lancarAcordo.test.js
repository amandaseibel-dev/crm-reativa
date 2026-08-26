import { describe, it, expect } from "vitest";
import { gerarParcelas, paraNumero, paraDataISO, somarMeses } from "./lancarAcordo";

// A regra de lancar acordo vale para a ficha E para a tela de lancamento --
// as duas chamam estas mesmas funcoes. Se um dia alguem mexer no rateio, e
// aqui que quebra primeiro.

const soma = (arr, campo) => arr.reduce((s, p) => s + Number(p[campo]), 0);

describe("gerar parcelas do acordo", () => {
  it("sem entrada: divide o total e o honorario pelas parcelas", () => {
    const r = gerarParcelas({
      valorTotal: "3000,00", qtdParcelas: "3", honorarios: "300,00",
      primeiroVenc: "10/09/2026",
    });
    expect(r.erro).toBe("");
    expect(r.parcelas).toHaveLength(3);
    expect(soma(r.parcelas, "valor")).toBeCloseTo(3000, 2);
    expect(soma(r.parcelas, "honorarios")).toBeCloseTo(300, 2);
  });

  it("com entrada: o honorario e rateado PELO VALOR, nao pela quantidade", () => {
    // Entrada de 1.000 num acordo de 3.000 = 1/3 do valor, entao leva 1/3 do
    // honorario -- mesmo sendo 1 de 3 lancamentos. Rateio por quantidade daria
    // 25% (1 de 4) e o numero sairia errado, que e o caso NORMAL: a entrada
    // quase sempre tem valor diferente das demais parcelas.
    const r = gerarParcelas({
      valorTotal: "3000,00", qtdParcelas: "3", temEntrada: true, entradaRs: "1000,00",
      honorarios: "300,00", primeiroVenc: "10/09/2026",
    });
    expect(Number(r.honorariosEntrada)).toBeCloseTo(100, 2);
    // O parcelado sai sobre o que sobra (2.000 em 3x) e leva o resto do honorario.
    expect(soma(r.parcelas, "valor")).toBeCloseTo(2000, 2);
    expect(soma(r.parcelas, "honorarios")).toBeCloseTo(200, 2);
    // Somando tudo, fecha com o combinado do acordo.
    expect(soma(r.parcelas, "honorarios") + Number(r.honorariosEntrada)).toBeCloseTo(300, 2);
  });

  it("entrada maior que o total nao gera parcelado negativo", () => {
    const r = gerarParcelas({
      valorTotal: "1000,00", qtdParcelas: "2", temEntrada: true, entradaRs: "5000,00",
      honorarios: "0", primeiroVenc: "10/09/2026",
    });
    expect(soma(r.parcelas, "valor")).toBe(0);
  });

  it("vencimentos caminham de mes em mes a partir do primeiro", () => {
    const r = gerarParcelas({
      valorTotal: "300,00", qtdParcelas: "3", honorarios: "0", primeiroVenc: "10/09/2026",
    });
    expect(r.parcelas.map((p) => p.vencimento)).toEqual(["10/09/2026", "10/10/2026", "10/11/2026"]);
  });

  it("dia 31 cai no ultimo dia do mes que nao tem 31", () => {
    expect(somarMeses("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("valor total zerado nao gera parcela nenhuma", () => {
    const r = gerarParcelas({ valorTotal: "", qtdParcelas: "3", primeiroVenc: "10/09/2026" });
    expect(r.parcelas).toHaveLength(0);
    expect(r.erro).toBeTruthy();
  });
});

describe("leitura de valor e data digitados", () => {
  it("aceita o jeito brasileiro de escrever dinheiro", () => {
    expect(paraNumero("1.234,56")).toBeCloseTo(1234.56, 2);
    expect(paraNumero("R$ 1.234,56")).toBeCloseTo(1234.56, 2);
    expect(paraNumero("1234.56")).toBeCloseTo(1234.56, 2);
    expect(paraNumero("")).toBe(0);
  });

  it("aceita data em dd/mm/aaaa e em ISO", () => {
    expect(paraDataISO("10/09/2026")).toBe("2026-09-10");
    expect(paraDataISO("2026-09-10")).toBe("2026-09-10");
    expect(paraDataISO("9/9/26")).toBe("2026-09-09");
  });
});

describe("centavo do arredondamento", () => {
  it("2.000 em 3x soma exatamente 2.000, nao 2.000,01", () => {
    // 2000/3 = 666,666... Arredondar cada parcela para 666,67 fazia as parcelas
    // somarem MAIS que o acordo. A ultima leva a diferenca.
    const r = gerarParcelas({
      valorTotal: "2000,00", qtdParcelas: "3", honorarios: "200,00",
      primeiroVenc: "10/09/2026",
    });
    expect(soma(r.parcelas, "valor")).toBe(2000);
    expect(soma(r.parcelas, "honorarios")).toBe(200);
    expect(r.parcelas.map((p) => p.valor)).toEqual(["666.67", "666.67", "666.66"]);
  });

  it("com entrada, entrada + parcelas fecham no total combinado", () => {
    const r = gerarParcelas({
      valorTotal: "1000,00", qtdParcelas: "7", temEntrada: true, entradaRs: "150,00",
      honorarios: "137,00", primeiroVenc: "10/09/2026",
    });
    expect(soma(r.parcelas, "valor") + 150).toBeCloseTo(1000, 10);
    expect(soma(r.parcelas, "honorarios") + Number(r.honorariosEntrada)).toBeCloseTo(137, 2);
  });
});

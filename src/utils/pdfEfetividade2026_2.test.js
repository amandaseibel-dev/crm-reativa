import { describe, it, expect } from "vitest";
import { montarPdfConsolidado2026_2 } from "./pdfEfetividade2026_2";

// Dados SINTÉTICOS: nenhum número real de produção aqui.
const INDICADORES = [
  { rotulo: "Valor negociado", valor: "R$ 1,0 mi", apoio: "Mensalidades com acordo: 10 de 100 da carteira" },
  { rotulo: "Valor recebido", valor: "R$ 0,4 mi", apoio: "40% do negociado" },
];
const SITUACAO = [
  { rotulo: "Regular", valor: 500 },
  { rotulo: "Quebrado", valor: 250.5 },
];
const CONTEXTO = { primeira_remessa: "2026-07-06", ultima_remessa: "2026-09-09", remessas: 15, carteira_valor: 9999 };
const moeda = (v) => "R$ " + Number(v).toFixed(2);

const texto = (doc) => String(doc.output());
const paginas = (doc) => (texto(doc).match(/\/Type \/Page\b(?!s)/g) || []).length;

describe("PDF 2026/2 consolidado", () => {
  it("traz filtros, indicadores, situação e entrada por borderô com datas reais", () => {
    const doc = montarPdfConsolidado2026_2({
      safra: "2026/2", indicadores: INDICADORES, situacao: SITUACAO, contexto: CONTEXTO,
      moeda, geradoEm: new Date("2026-11-12T10:00:00Z"),
    });
    const t = texto(doc);
    expect(t).toContain("Filtros: safra 2026/2");
    expect(t).toContain("Primeira remessa");
    expect(t).toContain("15 remessas");
    expect(t).toContain("Valor negociado: R$ 1,0 mi");
    expect(t).toContain("Regular: R$ 500.00");
    expect(t).toContain("Recuperado desde a entrada por borderô não é medido");
    expect(paginas(doc)).toBe(1);
  });

  it("sem dados de borderô, não inventa data nem quantidade", () => {
    const doc = montarPdfConsolidado2026_2({
      safra: "2026/2", indicadores: INDICADORES, situacao: SITUACAO, contexto: null, moeda,
    });
    const t = texto(doc);
    expect(t).not.toMatch(/Primeira remessa \d/);
    expect(t).toContain("dispon");
  });

  it("muitas linhas quebram em nova página sem cortar conteúdo", () => {
    const muitos = Array.from({ length: 120 }, (_, i) => ({ rotulo: "Linha " + i, valor: i }));
    const doc = montarPdfConsolidado2026_2({
      safra: "2026/2", indicadores: INDICADORES, situacao: muitos, contexto: CONTEXTO, moeda,
    });
    expect(paginas(doc)).toBeGreaterThan(1);
    expect(texto(doc)).toContain("Linha 119: R$ 119.00");
  });
});

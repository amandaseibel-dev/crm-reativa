import { describe, it, expect } from "vitest";
import { rotuloFonteTotal, dataHoraBR } from "./fechamentoTotalMes";

// O total do mês do fechamento pode vir do relatório do Prime ou do sistema;
// a gestão precisa ler de onde veio sem abrir a aba de conferência.
describe("rotuloFonteTotal", () => {
  it("relatório do Prime diz de qual conferência", () => {
    const r = rotuloFonteTotal({ fonte: "relatorio", conferencia_id: "x", conferencia_em: "2026-09-03T13:41:10.960Z" });
    expect(r.startsWith("relatório do Prime (conferência de ")).toBe(true);
    expect(r).toMatch(/03\/09\/2026/);
  });

  it("sistema com conferência no mês foi escolha da gestão", () => {
    expect(rotuloFonteTotal({ fonte: "sistema", conferencia_id: "x" })).toBe("sistema (escolha da gestão)");
  });

  it("sistema sem conferência: não havia outra opção", () => {
    expect(rotuloFonteTotal({ fonte: "sistema", conferencia_id: null })).toBe("sistema (sem conferência no mês)");
  });

  it("sem bloco total_mes (prévia antiga) não quebra", () => {
    expect(rotuloFonteTotal(null)).toBe("");
    expect(rotuloFonteTotal(undefined)).toBe("");
  });
});

describe("dataHoraBR", () => {
  it("vazio ou inválido vira vazio", () => {
    expect(dataHoraBR("")).toBe("");
    expect(dataHoraBR("nao-e-data")).toBe("");
  });
  it("ISO vira DD/MM/AAAA HH:MM", () => {
    expect(dataHoraBR("2026-09-03T13:41:10.960Z")).toMatch(/^\d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}$/);
  });
});

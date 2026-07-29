import { describe, it, expect } from "vitest";
import { diaDoCliqueGrafico } from "./GraficoEvolucaoProjecao";

// Regressão do bug P0: no recharts v3 o onClick do gráfico NÃO passa
// activePayload (como fazia na v2), então o clique no dia não abria o modal.
// A correção lê o clique também no próprio Bar/Line. Este teste garante que a
// data (YYYY-MM-DD) é extraída corretamente em TODAS as formas que o recharts
// pode entregar o argumento do onClick.
describe("diaDoCliqueGrafico (clique no dia da evolução)", () => {
  it("extrai a data quando o Bar/Line entrega o datum direto (recharts v3)", () => {
    expect(diaDoCliqueGrafico({ dia: "2026-07-06", valor: 8236.87 })).toBe("2026-07-06");
  });

  it("extrai a data quando vem embrulhada em payload (Bar/activeDot recharts v3)", () => {
    expect(diaDoCliqueGrafico({ payload: { dia: "2026-07-15" } })).toBe("2026-07-15");
  });

  it("extrai a data do formato antigo do gráfico (activePayload, recharts v2)", () => {
    const evento = { activePayload: [{ payload: { dia: "2026-07-22" } }] };
    expect(diaDoCliqueGrafico(evento)).toBe("2026-07-22");
  });

  it("retorna null quando não há data (clique fora de um dia)", () => {
    expect(diaDoCliqueGrafico(null)).toBeNull();
    expect(diaDoCliqueGrafico({})).toBeNull();
    expect(diaDoCliqueGrafico({ activePayload: [] })).toBeNull();
    expect(diaDoCliqueGrafico({ payload: {} })).toBeNull();
  });
});

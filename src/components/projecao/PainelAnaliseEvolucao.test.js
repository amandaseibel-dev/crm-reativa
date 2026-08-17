import { describe, it, expect } from "vitest";
import { mediaDiasFechados } from "./PainelAnaliseEvolucao";

// PREMISSA (Amanda, 2026-08-17): a projeção/ritmo trabalha com UM DIA ÚTIL A
// MENOS -- só dia FECHADO entra na média. Boleto e parte dos cartões só caem no
// dia seguinte; no próprio dia entra basicamente PIX, então o dia corrente está
// incompleto e não pode virar base de comparação.
describe("mediaDiasFechados (média diária só com dia fechado)", () => {
  const HOJE = "2026-08-17";

  it("deixa o dia de hoje fora da média", () => {
    const dias = [
      { dia: "2026-08-13", valor_recuperado: 100 },
      { dia: "2026-08-14", valor_recuperado: 300 },
      { dia: HOJE, valor_recuperado: 20 }, // dia em aberto (só o PIX entrou)
    ];
    // (100 + 300) / 2 = 200 -- e não (100+300+20)/3 = 140
    expect(mediaDiasFechados(dias, HOJE)).toBe(200);
  });

  it("ignora dias sem lançamento (não puxam a média pra baixo)", () => {
    const dias = [
      { dia: "2026-08-13", valor_recuperado: 100 },
      { dia: "2026-08-14", valor_recuperado: 0 },
      { dia: "2026-08-15", valor_recuperado: 300 },
    ];
    expect(mediaDiasFechados(dias, HOJE)).toBe(200);
  });

  it("aceita a data com timestamp (compara só a parte YYYY-MM-DD)", () => {
    const dias = [
      { dia: "2026-08-14", valor_recuperado: 500 },
      { dia: `${HOJE}T00:00:00`, valor_recuperado: 999999 },
    ];
    expect(mediaDiasFechados(dias, HOJE)).toBe(500);
  });

  it("retorna 0 quando só existe o dia em aberto (sem base de comparação)", () => {
    expect(mediaDiasFechados([{ dia: HOJE, valor_recuperado: 1234 }], HOJE)).toBe(0);
  });

  it("retorna 0 sem histórico", () => {
    expect(mediaDiasFechados([], HOJE)).toBe(0);
    expect(mediaDiasFechados(null, HOJE)).toBe(0);
  });
});

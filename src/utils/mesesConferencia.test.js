import { describe, it, expect } from "vitest";
import { listarMeses } from "./mesesConferencia";

// O defeito que motivou o arquivo: em 01/09/2026 a lista era escrita a mao e
// parava em agosto -- setembro nao existia em botao nenhum.
describe("listarMeses", () => {
  it("inclui o mes corrente", () => {
    const l = listarMeses(new Date(2026, 8, 1)); // setembro/2026
    expect(l.map((m) => m.chave)).toContain("2026-09");
    expect(l.find((m) => m.chave === "2026-09")).toMatchObject({
      rotulo: "Setembro", de: "2026-09-01", ate: "2026-09-30",
    });
  });

  it("o padrao e mes anterior + mes corrente, e e o primeiro botao", () => {
    const l = listarMeses(new Date(2026, 8, 15));
    expect(l[0]).toMatchObject({
      chave: "RECENTE", rotulo: "Agosto e setembro",
      de: "2026-08-01", ate: "2026-09-30",
    });
  });

  it("o limite e o ULTIMO DIA do mes, nao o primeiro do seguinte", () => {
    const l = listarMeses(new Date(2026, 8, 1));
    expect(l.find((m) => m.chave === "2026-08").ate).toBe("2026-08-31");
  });

  it("nao volta antes de junho/2026 -- nao ha extrato importado antes disso", () => {
    const chaves = listarMeses(new Date(2026, 8, 1)).map((m) => m.chave);
    expect(chaves).toContain("2026-06");
    expect(chaves).not.toContain("2026-05");
  });

  it("em junho/2026 nao ha mes anterior: comeca no proprio mes", () => {
    const l = listarMeses(new Date(2026, 5, 10));
    expect(l[0].chave).toBe("2026-06");
  });

  it("vira o ano e marca o ano no rotulo do que ficou para tras", () => {
    const l = listarMeses(new Date(2027, 0, 5)); // janeiro/2027
    expect(l[0]).toMatchObject({ chave: "RECENTE", de: "2026-12-01", ate: "2027-01-31" });
    expect(l.find((m) => m.chave === "2026-12").rotulo).toBe("Dezembro/2026");
  });

  it("fevereiro bissexto fecha no dia 29", () => {
    expect(listarMeses(new Date(2028, 1, 3)).find((m) => m.chave === "2028-02").ate)
      .toBe("2028-02-29");
  });

  it("termina em Tudo", () => {
    const l = listarMeses(new Date(2026, 8, 1));
    expect(l[l.length - 1]).toMatchObject({ chave: "TUDO", de: null, ate: null });
  });
});

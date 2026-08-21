import { describe, it, expect } from "vitest";
import { intervaloPeriodo, comoInputData, intervaloInvalido } from "./periodo";

describe("intervaloPeriodo", () => {
  it("atalhos não têm data final — pegam tudo dali pra frente", () => {
    for (const atalho of ["HOJE", "SEMANA", "MES"]) {
      const { desde, ate } = intervaloPeriodo(atalho);
      expect(desde).toBeInstanceOf(Date);
      expect(ate).toBeNull();
    }
  });

  it("TODOS não filtra nada", () => {
    expect(intervaloPeriodo("TODOS")).toEqual({ desde: null, ate: null });
  });

  it("personalizado cobre o dia inteiro das duas pontas", () => {
    const { desde, ate } = intervaloPeriodo("PERSONALIZADO", "2026-08-01", "2026-08-21");

    expect(desde.getFullYear()).toBe(2026);
    expect(desde.getMonth()).toBe(7);
    expect(desde.getDate()).toBe(1);
    expect(desde.getHours()).toBe(0);

    // o "até" precisa ir até o fim do dia, senão o que foi criado às 14h some
    expect(ate.getDate()).toBe(21);
    expect(ate.getHours()).toBe(23);
    expect(ate.getMinutes()).toBe(59);
  });

  it("personalizado aceita só uma ponta", () => {
    expect(intervaloPeriodo("PERSONALIZADO", "2026-08-01", "").ate).toBeNull();
    expect(intervaloPeriodo("PERSONALIZADO", "", "2026-08-21").desde).toBeNull();
  });
});

describe("intervaloInvalido", () => {
  it("acusa só quando as duas pontas existem e estão invertidas", () => {
    expect(intervaloInvalido("PERSONALIZADO", "2026-08-21", "2026-08-01")).toBe(true);
    expect(intervaloInvalido("PERSONALIZADO", "2026-08-01", "2026-08-21")).toBe(false);
    expect(intervaloInvalido("PERSONALIZADO", "2026-08-21", "")).toBe(false);
    expect(intervaloInvalido("MES", "2026-08-21", "2026-08-01")).toBe(false);
  });
});

describe("comoInputData", () => {
  it("formata com zero à esquerda", () => {
    expect(comoInputData(new Date(2026, 7, 5))).toBe("2026-08-05");
    expect(comoInputData(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

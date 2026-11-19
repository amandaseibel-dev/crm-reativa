// Descarte de grant OAuth que não entra na conexão. Revoga access E refresh, sem presumir cascata.
import { describe, it, expect } from "vitest";
import { descartarGrant } from "./grant.ts";

const T = { access_token: "acc-1", refresh_token: "ref-1" };

describe("descartarGrant", () => {
  it("revoga access e refresh separadamente, sem presumir cascata", async () => {
    const chamadas: string[] = [];
    const r = await descartarGrant(T, { revogar: async (tk) => { chamadas.push(tk); } });
    expect(chamadas).toEqual(["ref-1", "acc-1"]);
    expect(r).toEqual({ revogado: true, quarentena: false });
  });

  it("se o refresh falha, ainda tenta o access e fica pendente sem quarentena", async () => {
    const chamadas: string[] = [];
    const r = await descartarGrant(T, {
      revogar: async (tk) => { chamadas.push(tk); if (tk === "ref-1") throw new Error("X"); },
    });
    // Com retentativa: o refresh é tentado duas vezes antes de desistir; depois o access.
    expect(chamadas).toEqual(["ref-1", "ref-1", "acc-1"]);
    expect(r).toEqual({ revogado: false, quarentena: false, pendente: true });
  });

  it("revogação falha + quarentena gravada = quarentena (desconectar poderá revogar depois)", async () => {
    let marcada = false;
    const r = await descartarGrant(T, {
      revogar: async () => { throw new Error("fora do ar"); },
      quarentena: async () => "GRAVADA",
      marcarRevogada: async () => { marcada = true; },
    });
    expect(r).toEqual({ revogado: false, quarentena: true });
    expect(marcada).toBe(true);
  });

  it("quarentena recusada (EXISTENTE) ou com erro vira pendente, nunca 'revogado'", async () => {
    const existente = await descartarGrant(T, {
      revogar: async () => { throw new Error("x"); },
      quarentena: async () => "EXISTENTE",
      marcarRevogada: async () => {},
    });
    expect(existente).toEqual({ revogado: false, quarentena: false, pendente: true });
    const erro = await descartarGrant(T, {
      revogar: async () => { throw new Error("x"); },
      quarentena: async () => { throw new Error("banco"); },
      marcarRevogada: async () => {},
    });
    expect(erro).toEqual({ revogado: false, quarentena: false, pendente: true });
  });
});

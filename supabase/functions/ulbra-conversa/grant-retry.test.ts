// Falhas de revogação do grant: retentativa e registro de pendência (sem rede, sem banco).
import { describe, it, expect, vi } from "vitest";
import { descartarGrant } from "./grant.ts";

const T = { access_token: "acesso-x", refresh_token: "refresh-x" };

describe("descarte de grant: retentativa", () => {
  it("falha transitória: a segunda tentativa revoga os dois tokens", async () => {
    const revogar = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(undefined);
    const r = await descartarGrant(T, { revogar });
    expect(r).toEqual({ revogado: true, quarentena: false });
    // refresh: falha + ok (2 chamadas); access: ok (1 chamada)
    expect(revogar).toHaveBeenCalledTimes(3);
  });

  it("falha persistente sem quarentena: pendente (o chamador precisa registrar)", async () => {
    const revogar = vi.fn().mockRejectedValue(new Error("indisponível"));
    const r = await descartarGrant(T, { revogar });
    expect(r).toEqual({ revogado: false, quarentena: false, pendente: true });
    expect(revogar).toHaveBeenCalledTimes(4); // 2 tentativas por token, 2 tokens
  });

  it("falha persistente com quarentena gravada: quarentena (sem pendente)", async () => {
    const revogar = vi.fn().mockRejectedValue(new Error("indisponível"));
    const r = await descartarGrant(T, {
      revogar,
      quarentena: async () => "GRAVADA",
      marcarRevogada: async () => undefined,
    });
    expect(r).toEqual({ revogado: false, quarentena: true });
  });
});

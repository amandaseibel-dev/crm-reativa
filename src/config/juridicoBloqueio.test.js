import { describe, it, expect, vi, beforeEach } from "vitest";

describe("BLOQUEIO_ENVIO_JURIDICO_ATIVO (espelho de front)", () => {
  beforeEach(() => { vi.resetModules(); });
  it("ausente = desligado", async () => {
    vi.stubEnv("VITE_JURIDICO_BLOQUEIO_ENVIO_ATIVO", "");
    const m = await import("./juridicoBloqueio.js");
    expect(m.BLOQUEIO_ENVIO_JURIDICO_ATIVO).toBe(false);
  });
  it("valor explícito = ligado", async () => {
    vi.stubEnv("VITE_JURIDICO_BLOQUEIO_ENVIO_ATIVO", "true");
    const m = await import("./juridicoBloqueio.js");
    expect(m.BLOQUEIO_ENVIO_JURIDICO_ATIVO).toBe(true);
  });
});

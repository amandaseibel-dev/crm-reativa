import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chamarRpcContido, invalidarRpcContido } from "./rpcResiliente";

// Cache curto compartilhado (60s) e single-flight das RPCs secundarias
// (contadores_cabecalho e afins). Estes freios sao o que garante que o
// refoco NAO vira ida ao banco em toda alternancia de janela.

// supabase.rpc(nome, params).abortSignal(signal) -> Promise<{data,error}>
function fakeSupabase(impl) {
  return {
    rpc: vi.fn(() => ({
      abortSignal: () => impl(),
    })),
  };
}

describe("chamarRpcContido", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invalidarRpcContido(); // limpa cache global entre testes
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("(d) cache de 60s: repete a RPC so depois de expirar", async () => {
    const supa = fakeSupabase(() => Promise.resolve({ data: { n: 1 }, error: null }));

    const r1 = await chamarRpcContido(supa, "contadores_cabecalho", {}, { cacheMs: 60000, tentativasExtras: 0 });
    const r2 = await chamarRpcContido(supa, "contadores_cabecalho", {}, { cacheMs: 60000, tentativasExtras: 0 });

    expect(r1.data).toEqual({ n: 1 });
    expect(r2.data).toEqual({ n: 1 });
    expect(supa.rpc).toHaveBeenCalledTimes(1); // 2a chamada servida do cache

    // Antes de 60s: ainda cache.
    vi.advanceTimersByTime(59000);
    await chamarRpcContido(supa, "contadores_cabecalho", {}, { cacheMs: 60000, tentativasExtras: 0 });
    expect(supa.rpc).toHaveBeenCalledTimes(1);

    // Passados 60s: expira e vai ao banco de novo.
    vi.advanceTimersByTime(2000);
    await chamarRpcContido(supa, "contadores_cabecalho", {}, { cacheMs: 60000, tentativasExtras: 0 });
    expect(supa.rpc).toHaveBeenCalledTimes(2);
  });

  it("(e) single-flight: duas chamadas concorrentes = uma ida ao banco", async () => {
    let resolver;
    const supa = fakeSupabase(() => new Promise((r) => { resolver = r; }));

    // Dispara duas SEM aguardar a primeira: devem compartilhar a mesma execucao.
    const p1 = chamarRpcContido(supa, "contadores_cabecalho", {}, { cacheMs: 60000, tentativasExtras: 0 });
    const p2 = chamarRpcContido(supa, "contadores_cabecalho", {}, { cacheMs: 60000, tentativasExtras: 0 });

    resolver({ data: { n: 7 }, error: null });
    const [a, b] = await Promise.all([p1, p2]);

    expect(a.data).toEqual({ n: 7 });
    expect(b.data).toEqual({ n: 7 });
    expect(supa.rpc).toHaveBeenCalledTimes(1); // single-flight
  });

  it("nao cacheia resposta com erro (permite nova tentativa)", async () => {
    const supa = fakeSupabase(() => Promise.resolve({ data: null, error: { message: "boom" } }));

    await chamarRpcContido(supa, "contadores_cabecalho", {}, { cacheMs: 60000, tentativasExtras: 0 });
    await chamarRpcContido(supa, "contadores_cabecalho", {}, { cacheMs: 60000, tentativasExtras: 0 });

    expect(supa.rpc).toHaveBeenCalledTimes(2); // erro nao entra no cache
  });
});

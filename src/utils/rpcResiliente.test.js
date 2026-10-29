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

  it("(f) invalidarRpcContido() sem args forca nova consulta (isolamento entre usuarios)", async () => {
    const supa = fakeSupabase(() => Promise.resolve({ data: { n: 42 }, error: null }));

    // Usuario A faz a primeira chamada, popula cache
    await chamarRpcContido(supa, "contadores_cabecalho", {}, { cacheMs: 300000, tentativasExtras: 0 });
    expect(supa.rpc).toHaveBeenCalledTimes(1);

    // Segunda chamada dentro do TTL: servida do cache
    await chamarRpcContido(supa, "contadores_cabecalho", {}, { cacheMs: 300000, tentativasExtras: 0 });
    expect(supa.rpc).toHaveBeenCalledTimes(1);

    // Logout: invalida tudo
    invalidarRpcContido();

    // Proxima chamada (usuario B) deve ir ao banco
    await chamarRpcContido(supa, "contadores_cabecalho", {}, { cacheMs: 300000, tentativasExtras: 0 });
    expect(supa.rpc).toHaveBeenCalledTimes(2);
  });

  it("(g) invalidarRpcContido(nome) forca nova consulta sem apagar outras entradas", async () => {
    const supaA = fakeSupabase(() => Promise.resolve({ data: { n: 1 }, error: null }));
    const supaB = fakeSupabase(() => Promise.resolve({ data: { n: 2 }, error: null }));

    // Popula duas entradas diferentes
    await chamarRpcContido(supaA, "contadores_cabecalho", {}, { cacheMs: 300000, tentativasExtras: 0 });
    await chamarRpcContido(supaB, "outra_rpc", {}, { cacheMs: 300000, tentativasExtras: 0 });

    // Invalida somente contadores_cabecalho
    invalidarRpcContido("contadores_cabecalho");

    // contadores_cabecalho deve ir ao banco novamente
    await chamarRpcContido(supaA, "contadores_cabecalho", {}, { cacheMs: 300000, tentativasExtras: 0 });
    expect(supaA.rpc).toHaveBeenCalledTimes(2);

    // outra_rpc ainda serve do cache
    await chamarRpcContido(supaB, "outra_rpc", {}, { cacheMs: 300000, tentativasExtras: 0 });
    expect(supaB.rpc).toHaveBeenCalledTimes(1);
  });

  it("(h) request em voo antes do logout nao grava no cache apos invalidarRpcContido()", async () => {
    let resolver;
    const supa = fakeSupabase(() => new Promise((r) => { resolver = r; }));

    // Inicia request sem aguardar (em voo)
    const promessa = chamarRpcContido(supa, "contadores_cabecalho", {}, { cacheMs: 300000, tentativasExtras: 0 });

    // Logout acontece ANTES do request completar
    invalidarRpcContido();

    // Agora o request completa com dado do usuario anterior
    resolver({ data: { n: 99 }, error: null });
    await promessa;

    // Cache deve estar vazio: novo usuario nao deve ver dado do anterior
    const supa2 = fakeSupabase(() => Promise.resolve({ data: { n: 0 }, error: null }));
    await chamarRpcContido(supa2, "contadores_cabecalho", {}, { cacheMs: 300000, tentativasExtras: 0 });
    expect(supa2.rpc).toHaveBeenCalledTimes(1); // foi ao banco, nao serviu do cache contaminado
  });
});

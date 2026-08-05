// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import usePolling from "./polling";

// Testa a robustez do hook de polling apos a mudanca de semantica
// intervaloMs <= 0 (sem loop de relogio). Cobre: carga inicial unica,
// ausencia de setInterval em intervalo zero, debounce de foco de 3s,
// single-flight, cleanup completo e nenhuma execucao apos unmount.

describe("usePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("(a) faz uma unica carga inicial no mount", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      renderHook(() => usePolling(fn, 0));
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("(b) NAO cria setInterval quando intervaloMs = 0", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const fn = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      renderHook(() => usePolling(fn, 0));
    });
    expect(spy).not.toHaveBeenCalled();
    // Avancar muito tempo nao dispara novas chamadas (nao ha relogio).
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("(b') cria setInterval e repete quando intervaloMs > 0", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const fn = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      renderHook(() => usePolling(fn, 1000));
    });
    expect(spy).toHaveBeenCalledTimes(1); // um unico timer
    // Avanca tick a tick, deixando a microtask (await fn) concluir entre eles,
    // para que o single-flight (rodandoRef) libere antes do proximo tick.
    for (let i = 0; i < 3; i++) {
      await act(async () => { vi.advanceTimersByTime(1000); });
    }
    // 1 (mount) + 3 (ticks). O document.hidden e false no jsdom por padrao.
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("(c) debounce de foco de 3s: rajada de foco = 1 chamada", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      renderHook(() => usePolling(fn, 0));
    });
    expect(fn).toHaveBeenCalledTimes(1); // so o mount

    // Rajada de eventos de foco em sequencia rapida.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    // Ainda nada: o disparo e debounced (3s).
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    // Apenas UMA chamada extra pela rajada inteira.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("(e) single-flight: nao dispara nova chamada com uma ainda em voo", async () => {
    let resolver;
    const fn = vi.fn(() => new Promise((r) => { resolver = r; }));
    const { result } = renderHook(() => usePolling(fn, 0));
    await act(async () => {}); // deixa o efeito de mount rodar
    expect(fn).toHaveBeenCalledTimes(1); // mount iniciou uma chamada (pendente)

    // Enquanto a primeira NAO resolveu, novos disparos sao ignorados.
    await act(async () => { result.current(); result.current(); });
    expect(fn).toHaveBeenCalledTimes(1);

    // Resolve a primeira; agora um novo disparo e permitido.
    await act(async () => { resolver(); });
    await act(async () => { result.current(); });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("(f)(g) cleanup completo: sem timers/listeners e sem execucao apos unmount", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const fn = vi.fn().mockResolvedValue(undefined);
    let unmount;
    await act(async () => {
      const r = renderHook(() => usePolling(fn, 1000));
      unmount = r.unmount;
    });
    const chamadasAntes = fn.mock.calls.length;

    await act(async () => { unmount(); });
    expect(clearSpy).toHaveBeenCalled(); // timer do interval foi limpo

    // Foco apos unmount: listener removido -> nenhuma chamada nova.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(10000);
    });
    expect(fn).toHaveBeenCalledTimes(chamadasAntes);
  });
});

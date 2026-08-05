// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

// Mocks leves: isolam a RPC e evitam importar a ficha pesada do aluno.
const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: { rpc: (...a) => rpcMock(...a) },
}));
vi.mock("../pages/Aluno", () => ({ default: () => null }));
vi.mock("../ui/cards", () => ({ modalBox: {} }));

import CasosSemValor from "./CasosSemValor";

// Helper: supabase.rpc(nome).abortSignal(signal) -> Promise<{data,error}>.
function comResposta(fabricaPromise) {
  rpcMock.mockImplementation(() => ({
    abortSignal: () => fabricaPromise(),
  }));
}

describe("CasosSemValor.carregar", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(3a) dispara a RPC uma unica vez no mount (sem duplicar)", async () => {
    comResposta(() => Promise.resolve({ data: [], error: null }));
    await act(async () => {
      render(<CasosSemValor aoAtualizarContagem={() => {}} />);
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("listar_casos_sem_valor");
  });

  it("(3c) aborta a requisicao pendente no unmount", async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    let resolver;
    comResposta(() => new Promise((r) => { resolver = r; }));

    let unmount;
    await act(async () => {
      const r = render(<CasosSemValor aoAtualizarContagem={() => {}} />);
      unmount = r.unmount;
    });

    await act(async () => { unmount(); });
    expect(abortSpy).toHaveBeenCalled();

    // Resposta chega DEPOIS do unmount: nao deve quebrar nada.
    await act(async () => { resolver({ data: [{ id: 1 }], error: null }); });
  });

  it("(3d/5) AbortError nao vira log operacional nem erro visual", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // postgrest devolve o abort como { error } (nao lanca).
    comResposta(() => Promise.resolve({ data: null, error: { name: "AbortError", message: "AbortError: aborted" } }));

    await act(async () => {
      render(<CasosSemValor aoAtualizarContagem={() => {}} />);
    });

    expect(errSpy).not.toHaveBeenCalled();
  });

  it("erro real (nao-abort) e logado uma vez", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    comResposta(() => Promise.resolve({ data: null, error: { message: "falha de rede" } }));

    await act(async () => {
      render(<CasosSemValor aoAtualizarContagem={() => {}} />);
    });

    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});

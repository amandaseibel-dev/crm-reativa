// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, within } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import CasosPendentes from "./CasosPendentes";

// Numeros INVENTADOS, coerentes entre si: 800 + 300 - 100 = 1.000 pendentes
// de 1.200 ativos. Contagem real de caso nao entra em arquivo versionado.
const D = {
  gerado_em: "2026-10-07T12:00:00Z",
  escopo: "casos nao encerrados operacionalmente",
  casos_no_escopo: 1200, sem_pagamento: 800, com_acordo_aberto: 300,
  nos_dois: 100, pendentes: 1000,
};

const montar = async () => { await act(async () => { render(<CasosPendentes />); }); };
beforeEach(() => { rpcMock.mockReset(); rpcMock.mockResolvedValue({ data: D, error: null }); });
afterEach(cleanup);

function item(rotulo) { return screen.getByText(rotulo).closest("li"); }

describe("Casos ainda pendentes", () => {
  it("pede a contagem ao banco e não calcula nada no front", async () => {
    await montar();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("casos_pendentes_contar");
  });

  it("mostra o número de casos pendentes", async () => {
    await montar();
    expect(screen.getByText("1.000")).toBeTruthy();
    expect(screen.getByText(/de 1.200 ativos/)).toBeTruthy();
  });

  it("abre as duas condições e a sobreposição descontada", async () => {
    await montar();
    expect(within(item("Sem nenhum pagamento registrado")).getByText("800")).toBeTruthy();
    expect(within(item("Com acordo em aberto, saldo a receber")).getByText("300")).toBeTruthy();
    // a sobreposicao aparece como DESCONTO, para as tres linhas fecharem no total
    expect(within(item("Nos dois ao mesmo tempo (contados uma vez)")).getByText("−100")).toBeTruthy();
  });

  it("as três linhas fecham no total exibido", async () => {
    await montar();
    expect(D.sem_pagamento + D.com_acordo_aberto - D.nos_dois).toBe(D.pendentes);
    expect(screen.getByText(String(D.pendentes).replace("1000", "1.000"))).toBeTruthy();
  });

  it("diz que é da carteira inteira, não de uma safra", async () => {
    await montar();
    expect(screen.getByText(/não é por safra/)).toBeTruthy();
    expect(screen.getByText(/caso encerrado operacionalmente fica de fora/)).toBeTruthy();
  });

  it("diz que acordo quitado não entra", async () => {
    await montar();
    expect(screen.getByText(/Acordo quitado não entra/)).toBeTruthy();
  });

  it("singular quando é um caso só", async () => {
    rpcMock.mockResolvedValue({ data: { ...D, pendentes: 1 }, error: null });
    await montar();
    // o numero e o substantivo vivem em elementos separados, entao a conferencia
    // e do substantivo: "caso de 1.200 ativos", nunca "casos"
    expect(screen.getByText(/^caso de/)).toBeTruthy();
  });

  it("erro da RPC aparece na tela, não vira zero", async () => {
    rpcMock.mockResolvedValue({ error: { message: "Acesso negado." } });
    await montar();
    expect(screen.getByText(/Acesso negado/)).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });
});

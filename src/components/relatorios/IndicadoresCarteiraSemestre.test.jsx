// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../../services/supabase", () => ({
  supabase: { rpc: (...a) => rpcMock(...a) },
}));

import IndicadoresCarteiraSemestre from "./IndicadoresCarteiraSemestre";

const seis = {
  situacoes: {
    entrou: { valor: 1000000, alunos: 500, titulos: 900 },
    pago: { valor: 250000, alunos: 120, titulos: 200 },
    negociado: { valor: 300000, alunos: 150, titulos: 260 },
  },
};
const comp = { total: { valor: 400000, alunos: 210, titulos: 330 } };

afterEach(() => { cleanup(); rpcMock.mockReset(); });

describe("IndicadoresCarteiraSemestre — 2026/1 (efetividade)", () => {
  it("mostra saldo original, recuperado, negociado, aberto e % sobre o saldo original", async () => {
    rpcMock.mockImplementation((nome, args) => {
      if (nome !== "carteira_efetividade_ler") return Promise.resolve({ data: null, error: { message: "inesperada" } });
      return Promise.resolve({ data: args.p_bloco === "seis_linhas" ? seis : comp, error: null });
    });
    render(<IndicadoresCarteiraSemestre fonte={{ tipo: "efetividade", ano: "2026", semestre: "1" }} />);
    expect(await screen.findByText("Indicadores de carteira")).toBeTruthy();
    expect(screen.getByText("Saldo original recebido na carteira")).toBeTruthy();
    expect(screen.getByText("Percentual de recuperação")).toBeTruthy();
    // 250 mil ÷ 1 mi = 25,0%; negociado não entra no percentual
    expect(screen.getByText("25,0%")).toBeTruthy();
    expect(screen.getByText("ainda não é recebimento")).toBeTruthy();
    expect(rpcMock).toHaveBeenCalledWith("carteira_efetividade_ler", { p_bloco: "seis_linhas", p_ano: "2026", p_semestre: "1" });
    expect(rpcMock).toHaveBeenCalledWith("carteira_efetividade_ler", { p_bloco: "composicao_academica", p_ano: "2026", p_semestre: "1" });
  });

  it("sem fotografia oficial mostra traço no saldo em aberto, sem inventar número", async () => {
    rpcMock.mockImplementation((nome, args) =>
      Promise.resolve({ data: args.p_bloco === "seis_linhas" ? seis : { sem_snapshot: true }, error: null }));
    render(<IndicadoresCarteiraSemestre fonte={{ tipo: "efetividade", ano: "2026", semestre: "1" }} />);
    expect(await screen.findByText("sem fotografia oficial")).toBeTruthy();
  });
});

describe("IndicadoresCarteiraSemestre — 2026/2 (negociações)", () => {
  it("percentual é recebido ÷ negociado, sem usar a carteira inteira", async () => {
    rpcMock.mockResolvedValue({
      data: { total: { negociado: 94714.96, recebido: 71066.83, saldo: 23648.13, cpfs: 56, acordos: 56 } },
      error: null,
    });
    render(<IndicadoresCarteiraSemestre fonte={{ tipo: "negociacoes" }} />);
    expect(await screen.findByText("Percentual de recuperação")).toBeTruthy();
    // 71.066,83 ÷ 94.714,96 = 75,0%
    expect(screen.getByText("75,0%")).toBeTruthy();
    expect(screen.getByText(/saldo original da carteira ainda não é medido/)).toBeTruthy();
    expect(rpcMock).toHaveBeenCalledWith("carteira_2026_2_negociacoes");
  });
});

describe("IndicadoresCarteiraSemestre — erros e vazio", () => {
  it("mostra a mensagem de erro da RPC", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "Acesso negado." } });
    render(<IndicadoresCarteiraSemestre fonte={{ tipo: "negociacoes" }} />);
    await waitFor(() => expect(screen.getByText("Acesso negado.")).toBeTruthy());
  });

  it("sem payload reconhecível mostra aviso, sem números", async () => {
    rpcMock.mockResolvedValue({ data: { ok: true }, error: null });
    render(<IndicadoresCarteiraSemestre fonte={{ tipo: "negociacoes" }} />);
    expect(await screen.findByText("Sem fotografia de carteira para este semestre ainda.")).toBeTruthy();
  });
});

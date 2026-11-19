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
  snapshot: { gerado_em: "2026-11-19T14:52:17Z" },
};
const comp = { total: { valor: 400000, alunos: 210, titulos: 330 } };

afterEach(() => { cleanup(); rpcMock.mockReset(); });

describe("IndicadoresCarteiraSemestre — 2026/1 (efetividade)", () => {
  it("mostra 'Entrou na carteira' e 'Recuperado em pagamentos' lado a lado, com % = recuperado ÷ entrou", async () => {
    rpcMock.mockImplementation((nome, args) => {
      if (nome !== "carteira_efetividade_ler") return Promise.resolve({ data: null, error: { message: "inesperada" } });
      return Promise.resolve({ data: args.p_bloco === "seis_linhas" ? seis : comp, error: null });
    });
    render(<IndicadoresCarteiraSemestre fonte={{ tipo: "efetividade", ano: "2026", semestre: "1" }} />);
    expect(await screen.findByText("Entrou na carteira")).toBeTruthy();
    expect(screen.getByText("Recuperado em pagamentos")).toBeTruthy();
    expect(screen.getByText("25,0% de entrou na carteira")).toBeTruthy();
    expect(screen.getByText("ainda não é recebimento")).toBeTruthy();
    expect(rpcMock).toHaveBeenCalledWith("carteira_efetividade_ler", { p_bloco: "seis_linhas", p_ano: "2026", p_semestre: "1" });
    expect(rpcMock).toHaveBeenCalledWith("carteira_efetividade_ler", { p_bloco: "composicao_academica", p_ano: "2026", p_semestre: "1" });
  });

  it("sem fotografia oficial mostra traço no em aberto, sem inventar número", async () => {
    rpcMock.mockImplementation((nome, args) =>
      Promise.resolve({ data: args.p_bloco === "seis_linhas" ? seis : { sem_snapshot: true }, error: null }));
    render(<IndicadoresCarteiraSemestre fonte={{ tipo: "efetividade", ano: "2026", semestre: "1" }} />);
    expect(await screen.findByText("sem fotografia oficial")).toBeTruthy();
  });
});

describe("IndicadoresCarteiraSemestre — 2026/2 (ao vivo)", () => {
  it("entrou vem do contexto da carteira e recuperado é o recebido dos acordos; mesma regra de %", async () => {
    rpcMock.mockImplementation((nome) => {
      if (nome === "carteira_2026_2_contexto") {
        return Promise.resolve({ data: { carteira_valor: 1000000, carteira_titulos: 900, carteira_cpfs: 500, atualizado_em: "2026-11-19T14:47:30Z" }, error: null });
      }
      return Promise.resolve({
        data: { total: { negociado: 94714.96, recebido: 71066.83, saldo: 23648.13, cpfs: 56, acordos: 56 } },
        error: null,
      });
    });
    render(<IndicadoresCarteiraSemestre fonte={{ tipo: "negociacoes" }} />);
    expect(await screen.findByText("Entrou na carteira")).toBeTruthy();
    expect(screen.getByText("Recuperado em pagamentos")).toBeTruthy();
    // 71.066,83 ÷ 1.000.000 = 7,1%
    expect(screen.getByText("7,1% de entrou na carteira")).toBeTruthy();
    expect(screen.getByText(/pagamentos de títulos fora de acordo ainda não entram/)).toBeTruthy();
    expect(rpcMock).toHaveBeenCalledWith("carteira_2026_2_negociacoes");
    expect(rpcMock).toHaveBeenCalledWith("carteira_2026_2_contexto");
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

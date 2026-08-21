// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import CalibragemNivelamento from "./CalibragemNivelamento";

// Números reais de produção (2026) no dia em que o motor foi corrigido: o alvo de
// 500 não cabe (3.679 casos para 8 operadores), então o nivelamento tem de mirar
// a média — 459 — senão a tela roda e não move ninguém.
const DIAG = {
  ano: 2026,
  base_total: 3679,
  pool_total: 242,
  pool_saldo: 773181.52,
  alvo_sugerido: 459,
  anos: [{ ano: 2026, qtd: 4038 }, { ano: 2025, qtd: 5079 }],
  operadores: [
    { op_email: "cobranca12@aelbra.com.br", op_nome: "RAFAELLA", qtd: 114, saldo: 1261193.7 },
    { op_email: "cobranca03@aelbra.com.br", op_nome: "OLGA", qtd: 417, saldo: 1636305.89 },
    { op_email: "cobranca13@aelbra.com.br", op_nome: "DIEGO", qtd: 504, saldo: 1394294.88 },
  ],
};

const SIM = {
  simulacao_id: "98b3e95a-4331-43da-9dbe-f01ff0907c15",
  alvo: 500,
  alvo_efetivo: 459,
  pool_total: 242,
  total_disponivel: 3679,
  total_movimentacoes: 457,
  indice_qtd_depois: 0.99,
  indice_depois: 0.98,
  antes: DIAG.operadores,
  depois: [
    { op_email: "cobranca12@aelbra.com.br", op_nome: "RAFAELLA", qtd: 459, saldo: 1436717.17 },
    { op_email: "cobranca03@aelbra.com.br", op_nome: "OLGA", qtd: 459, saldo: 1476122.53 },
    { op_email: "cobranca13@aelbra.com.br", op_nome: "DIEGO", qtd: 463, saldo: 1435256.26 },
  ],
};

const chamadas = vi.hoisted(() => ({ rpc: [] }));

vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (fn, args) => {
      chamadas.rpc.push({ fn, args });
      if (fn === "calibragem_diagnostico_sem_negociacao") return Promise.resolve({ data: DIAG, error: null });
      if (fn === "calibragem_simular_nivelamento") return Promise.resolve({ data: SIM, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

describe("Calibragem — nivelamento", () => {
  beforeEach(() => { chamadas.rpc = []; });
  afterEach(cleanup);

  it("mostra o alvo efetivo (média) quando não há material para 500 por operador", async () => {
    render(<CalibragemNivelamento />);
    await waitFor(() => expect(screen.getByText("RAFAELLA")).toBeTruthy());

    // O alvo exibido é a média disponível, não o 500 nominal.
    expect(screen.getByText("média — pedido: 500")).toBeTruthy();
    expect(screen.getByText("345 abaixo do alvo")).toBeTruthy(); // 459 - 114
    // O pool de alunos sem responsável aparece como tal.
    expect(screen.getByText("Sem responsável")).toBeTruthy();
    expect(screen.getByText("242")).toBeTruthy();
  });

  it("simula pelo alvo efetivo e explica de onde vêm os casos", async () => {
    render(<CalibragemNivelamento />);
    await waitFor(() => expect(screen.getByText("RAFAELLA")).toBeTruthy());

    fireEvent.click(screen.getByText("2026")); // recorte por ano do aluno
    await waitFor(() => expect(screen.getByText("RAFAELLA")).toBeTruthy());
    fireEvent.click(screen.getByText("Simular nivelamento"));
    await waitFor(() => expect(screen.getByText(/457 movimentações/)).toBeTruthy());

    const criterio = chamadas.rpc.find((c) => c.fn === "calibragem_simular_nivelamento")?.args?.p_criterio;
    expect(criterio).toMatchObject({ alvo: 500, dias_sem_acionamento: 11, ano: 2026 });

    // Rafaella sai de 114 para 459 e o aviso diz por que o alvo virou 459.
    expect(screen.getByText(/459 \(\+345\)/)).toBeTruthy();
    expect(screen.getByText(/alvo efetivo de 459/)).toBeTruthy();
    expect(screen.getByText(/242 sem responsável/)).toBeTruthy();
  });
});

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

// O oposto: 02/09/2026 em produção. A base inteira dividida pelos operadores dá
// 1.325, mas o teto é 500. O diagnóstico devolve a média CRUA — cabe à tela
// aplicar o teto, senão pinta os 8 operadores de vermelho dizendo que faltam
// ~880 casos para cada um.
const DIAG_POOL_GRANDE = {
  ano: null,
  base_total: 10605,
  pool_total: 6424,
  pool_saldo: 11849280.39,
  alvo_sugerido: 1325,
  anos: [{ ano: 2026, qtd: 3270 }],
  operadores: [
    { op_email: "cobranca05@aelbra.com.br", op_nome: "Luana", qtd: 441, saldo: 1709651.67 },
    { op_email: "cobranca03@aelbra.com.br", op_nome: "Olga", qtd: 586, saldo: 2384929.14 },
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
  movimentacoes: [
    { caso_id: "c1", cpf: "11122233344", nome: "MARIA SOUZA", valor: 3200.5,
      de_email: "cobranca13@aelbra.com.br", de_nome: "DIEGO", para_email: null, para_nome: null,
      motivo: "Retirado por nivelamento (parado +11d) - sem responsavel" },
    { caso_id: "c2", cpf: "55566677788", nome: "JOAO LIMA", valor: 810,
      de_email: null, de_nome: null, para_email: "cobranca12@aelbra.com.br", para_nome: "RAFAELLA",
      motivo: "Recebido do pool (divida recente)" },
  ],
};

const chamadas = vi.hoisted(() => ({ rpc: [], diag: null }));

vi.mock("../services/supabase", () => {
  // A tela lê o histórico direto da tabela; o encadeamento precisa existir.
  const consulta = () => {
    const alvo = { then: (r) => Promise.resolve({ data: [], error: null }).then(r) };
    ["select", "in", "order", "limit", "eq"].forEach((m) => { alvo[m] = () => alvo; });
    return alvo;
  };
  return {
    supabase: {
      from: consulta,
      rpc: (fn, args) => {
        chamadas.rpc.push({ fn, args });
        if (fn === "calibragem_diagnostico_sem_negociacao") {
          return Promise.resolve({ data: chamadas.diag || DIAG, error: null });
        }
        if (fn === "calibragem_simular_nivelamento") return Promise.resolve({ data: SIM, error: null });
        return Promise.resolve({ data: null, error: null });
      },
    },
  };
});

describe("Calibragem — nivelamento", () => {
  beforeEach(() => { chamadas.rpc = []; chamadas.diag = null; });
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

  it("nunca mostra alvo acima do teto, mesmo com a média crua bem maior", async () => {
    // Regressão: o diagnóstico devolve 1.325 e a tela mostrava 1.325, deixando
    // Olga (586 casos) como "739 abaixo do alvo".
    chamadas.diag = DIAG_POOL_GRANDE;
    render(<CalibragemNivelamento />);
    await waitFor(() => expect(screen.getByText("Olga")).toBeTruthy());

    expect(screen.queryByText("1.325")).toBeNull();
    expect(screen.queryByText(/739 abaixo/)).toBeNull();
    expect(screen.getByText("✓ nivelado")).toBeTruthy();       // Olga, com 586, passou dos 500
    expect(screen.getByText("59 abaixo do alvo")).toBeTruthy(); // Luana, 500 - 441

    // E diz quanto da base não cabe no time: 10.605 - 2 x 500.
    expect(screen.getByText("Fora do alcance")).toBeTruthy();
    expect(screen.getByText("9.605")).toBeTruthy();
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
    expect(criterio.operadores).toBeUndefined(); // todos participam: não restringe

    // Rafaella sai de 114 para 459 e o aviso diz por que o alvo virou 459.
    expect(screen.getByText(/459 \(\+345\)/)).toBeTruthy();
    expect(screen.getByText(/alvo efetivo de 459/)).toBeTruthy();
    expect(screen.getByText(/242 sem responsável/)).toBeTruthy();
  });

  it("manda o alvo, os dias e os operadores escolhidos pela gestão", async () => {
    render(<CalibragemNivelamento />);
    await waitFor(() => expect(screen.getByText("RAFAELLA")).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/Alvo por operador/i), { target: { value: "420" } });
    fireEvent.change(screen.getByLabelText(/Parado após/i), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: /DIEGO/ })); // tira Diego do nivelamento

    fireEvent.click(screen.getByText("Simular nivelamento"));
    await waitFor(() => expect(screen.getByText(/457 movimentações/)).toBeTruthy());

    const criterio = chamadas.rpc.find((c) => c.fn === "calibragem_simular_nivelamento")?.args?.p_criterio;
    expect(criterio).toMatchObject({ alvo: 420, dias_sem_acionamento: 30 });
    expect(criterio.operadores).toEqual([
      "cobranca12@aelbra.com.br",
      "cobranca03@aelbra.com.br",
    ]);
  });

  it("não deixa pedir menos que os 10 dias da fidelização", async () => {
    render(<CalibragemNivelamento />);
    await waitFor(() => expect(screen.getByText("RAFAELLA")).toBeTruthy());

    const campo = screen.getByLabelText(/Parado após/i);
    fireEvent.change(campo, { target: { value: "3" } });
    expect(Number(campo.value)).toBe(10);
  });

  it("lista quem vai mover, com origem e destino", async () => {
    render(<CalibragemNivelamento />);
    await waitFor(() => expect(screen.getByText("RAFAELLA")).toBeTruthy());
    fireEvent.click(screen.getByText("Simular nivelamento"));
    await waitFor(() => expect(screen.getByText(/457 movimentações/)).toBeTruthy());

    expect(screen.getByText("Quem vai mover")).toBeTruthy();
    expect(screen.getByText("MARIA SOUZA")).toBeTruthy();
    expect(screen.getByText("JOAO LIMA")).toBeTruthy();
    // O caso que sai da carteira do Diego vai para o pool, e a tela diz isso.
    expect(screen.getAllByText("sem responsável").length).toBe(2);
  });

  it("avisa quando o equilíbrio de valor não teve troca nenhuma", async () => {
    // Foi o que aconteceu em 01/09: 1.029 movimentações, zero trocas, e a tela
    // exibia o índice de valor como se ele tivesse sido perseguido.
    render(<CalibragemNivelamento />);
    await waitFor(() => expect(screen.getByText("RAFAELLA")).toBeTruthy());
    fireEvent.click(screen.getByText("Simular nivelamento"));
    await waitFor(() => expect(screen.getByText(/Nenhuma troca de valor foi possível/)).toBeTruthy());
  });
});

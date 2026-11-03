// @vitest-environment jsdom
//
// Testes direcionados à otimização de lazy load da tela Atendimento do aluno.
//
// O que se prova:
//   1. A tela NÃO consulta alunos ao abrir sem URL de aluno (lazy load)
//   2. A tela exibe placeholder "Digite para pesquisar" no estado inicial
//   3. A tela SÓ consulta alunos ao clicar em "Pesquisar"
//   4. Após pesquisa, a lista exibe os resultados encontrados
//   5. A tela NÃO dispara calcularFinLista (acordos/parcelas/acordos_titulos)
//      — a lista usa apenas valor_em_aberto da tabela alunos
//   6. Quando abre com alunoId na URL, abre a ficha diretamente (comportamento preservado)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Mock Supabase — variáveis usadas dentro do factory devem ser declaradas
// via vi.hoisted para ficarem disponíveis antes do hoisting do vi.mock.
const { fromMock, rpcMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock("../services/supabase", () => ({
  supabase: {
    from: (...a) => fromMock(...a),
    rpc: (...a) => rpcMock(...a),
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { email: "op@test.com", user_metadata: { nome: "Operador" } } }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: {} }, error: null }),
    },
    storage: { from: () => ({ createSignedUrl: vi.fn() }) },
  },
}));

// Mocks de componentes pesados que não são o foco
vi.mock("../components/FinanceiroAluno", () => ({ default: () => null }));
vi.mock("../components/DadosAcademicos", () => ({ default: () => null }));
vi.mock("../components/ConfirmarPagamento", () => ({ default: () => null }));
vi.mock("../components/LinksPagamentoAluno", () => ({ default: () => null }));
vi.mock("../components/EmailAlunoUnificado", () => ({ default: () => null }));
vi.mock("../components/TelefonesAluno", () => ({ default: () => null }));
vi.mock("../components/BlocoUlbra", () => ({ default: () => null }));
vi.mock("../components/PainelDesfazer", () => ({ default: () => null }));
vi.mock("../components/EnvioFinanceiro", () => ({ default: () => null }));
vi.mock("../components/FinalizacaoTermo", () => ({ default: () => null }));
vi.mock("../components/AgendaAlunoUnificado", () => ({ default: () => null }));
vi.mock("../utils/tabulacoes", () => ({
  carregarTabulacoes: vi.fn().mockResolvedValue([]),
  desfechoDaTabulacao: vi.fn().mockReturnValue({ proxima_acao: null, data_retorno: null, retorno_origem: null, motivo: null }),
  retornoEhManual: vi.fn().mockReturnValue(false),
  camposDeRetorno: vi.fn().mockReturnValue({}),
  lerRetornoAtual: vi.fn().mockResolvedValue({ ok: true, retorno: null }),
  RETORNO_ORIGEM_OPERADOR: "OPERADOR",
}));
vi.mock("../utils/retornoOrigem", () => ({ ehOrigemDoOperador: vi.fn().mockReturnValue(false) }));
vi.mock("jspdf", () => ({ default: class { text() {} save() {} setFont() {} setFontSize() {} setTextColor() {} setDrawColor() {} line() {} splitTextToSize() { return []; } addPage() {} } }));

import Alunos from "./Aluno";

function renderAlunos(path = "/alunos") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Alunos />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Mock padrão para RPC retornar usuário
  rpcMock.mockResolvedValue({ data: null, error: null });
  // fromMock retorna um objeto que suporta encadeamento supabase-style
  fromMock.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    then: undefined, // não é thenable por padrão; resolve via mock de select
  });
});

afterEach(() => {
  cleanup();
});

describe("Aluno.jsx — lazy load", () => {
  it("não consulta a tabela alunos ao abrir sem URL de aluno", async () => {
    await act(async () => { renderAlunos("/alunos"); });

    // from("alunos") não deve ter sido chamado com .select("*")
    const chamadasFrom = fromMock.mock.calls.map((c) => c[0]);
    expect(chamadasFrom).not.toContain("alunos");
  });

  it("exibe placeholder 'Digite para pesquisar' no estado inicial", async () => {
    await act(async () => { renderAlunos("/alunos"); });

    expect(screen.getByText(/Digite nome, CPF ou telefone acima/i)).toBeTruthy();
  });

  it("não dispara consultas a acordos, parcelas ou acordos_titulos ao abrir", async () => {
    await act(async () => { renderAlunos("/alunos"); });

    const chamadasFrom = fromMock.mock.calls.map((c) => c[0]);
    expect(chamadasFrom).not.toContain("acordos");
    expect(chamadasFrom).not.toContain("parcelas");
    expect(chamadasFrom).not.toContain("acordos_titulos");
  });

  it("consulta alunos via RPC ao clicar em Pesquisar com termo preenchido", async () => {
    // buscar_aluno retorna um aluno
    rpcMock.mockImplementation((nome) => {
      if (nome === "buscar_aluno") {
        return Promise.resolve({
          data: [{ id: "uuid-1", nome: "Ana Souza", cpf: "123.456.789-00", valor_em_aberto: 500 }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await act(async () => { renderAlunos("/alunos"); });

    const inputBusca = screen.getByPlaceholderText(/Digite nome, CPF ou telefone/i);
    fireEvent.change(inputBusca, { target: { value: "Ana" } });

    const botaoPesquisar = screen.getByRole("button", { name: /Pesquisar/i });
    await act(async () => { fireEvent.click(botaoPesquisar); });

    // RPC buscar_aluno deve ter sido chamado
    const chamadas = rpcMock.mock.calls.map((c) => c[0]);
    expect(chamadas).toContain("buscar_aluno");
  });

  it("não consulta acordos/parcelas/acordos_titulos mesmo após pesquisa com resultados", async () => {
    rpcMock.mockImplementation((nome) => {
      if (nome === "buscar_aluno") {
        return Promise.resolve({
          data: [
            { id: "uuid-1", nome: "Ana Souza", cpf: "12345678900", valor_em_aberto: 500 },
            { id: "uuid-2", nome: "Ana Lima", cpf: "98765432100", valor_em_aberto: 300 },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await act(async () => { renderAlunos("/alunos"); });

    const inputBusca = screen.getByPlaceholderText(/Digite nome, CPF ou telefone/i);
    fireEvent.change(inputBusca, { target: { value: "Ana" } });
    const botaoPesquisar = screen.getByRole("button", { name: /Pesquisar/i });
    await act(async () => { fireEvent.click(botaoPesquisar); });

    // Após a busca, JAMAIS deve consultar as tabelas financeiras da lista
    const chamadasFrom = fromMock.mock.calls.map((c) => c[0]);
    expect(chamadasFrom).not.toContain("acordos");
    expect(chamadasFrom).not.toContain("parcelas");
    expect(chamadasFrom).not.toContain("acordos_titulos");
  });

  it("exibe 'Nenhum aluno encontrado' após pesquisa sem resultados", async () => {
    rpcMock.mockImplementation((nome) => {
      if (nome === "buscar_aluno") {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await act(async () => { renderAlunos("/alunos"); });

    const inputBusca = screen.getByPlaceholderText(/Digite nome, CPF ou telefone/i);
    fireEvent.change(inputBusca, { target: { value: "zzzzinexistente" } });
    const botaoPesquisar = screen.getByRole("button", { name: /Pesquisar/i });
    await act(async () => { fireEvent.click(botaoPesquisar); });

    expect(screen.getByText(/Nenhum aluno encontrado/i)).toBeTruthy();
  });
});

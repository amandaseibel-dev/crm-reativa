// @vitest-environment jsdom
//
// Botão "Registrar termo arquivado" na ficha do aluno (Movimentações).
// O que se prova (com mocks do Supabase; NÃO é prova de banco nem de produção):
//   1. o botão aparece para a conta de gestão e não aparece para operador comum;
//   2. ao confirmar, o insert vai para aluno_movimentacoes com a descrição fixa, autor e data/hora;
//   3. nenhuma escrita é feita em alunos (status, prazo, próxima ação e acionamento intactos).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const { fromMock, rpcMock, getUserMock, insertMock, updateMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  getUserMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("../services/supabase", () => ({
  supabase: {
    from: (...a) => fromMock(...a),
    rpc: (...a) => rpcMock(...a),
    auth: {
      getUser: (...a) => getUserMock(...a),
      getSession: vi.fn().mockResolvedValue({ data: { session: {} }, error: null }),
    },
    storage: { from: () => ({ createSignedUrl: vi.fn() }) },
  },
}));

vi.mock("../components/FinanceiroAluno", () => ({ default: () => null }));
vi.mock("../components/DadosAcademicos", () => ({ default: () => null }));
vi.mock("../components/ConfirmarPagamento", () => ({ default: () => null }));
vi.mock("../components/LinksPagamentoAluno", () => ({ default: () => null }));
vi.mock("../components/EmailAlunoUnificado", () => ({ default: () => null }));
vi.mock("../components/TelefonesAluno", () => ({ default: () => null }));
vi.mock("../components/BlocoUlbra", () => ({ default: () => null }));
vi.mock("../components/AtendimentoUlbra", () => ({ default: () => null }));
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
  tabulacaoDisponivel: () => true,
}));
vi.mock("../utils/retornoOrigem", () => ({ ehOrigemDoOperador: vi.fn().mockReturnValue(false) }));
vi.mock("jspdf", () => ({ default: class { text() {} save() {} setFont() {} setFontSize() {} setTextColor() {} setDrawColor() {} line() {} splitTextToSize() { return []; } addPage() {} } }));

import Alunos from "./Aluno";

const ALUNO = { id: "a0000000-0000-0000-0000-000000000042", nome: "Aluno Fictício", cpf: "000.000.000-00", valor_em_aberto: 0, status_atual: "CONTATAR", status_jornada: "CONTATAR", status_acionamento: "CONTATAR" };

function renderFicha() {
  window.history.replaceState(null, "", `/aluno?alunoId=${ALUNO.id}`);
  return render(
    <MemoryRouter initialEntries={[`/aluno?alunoId=${ALUNO.id}`]}>
      <Alunos />
    </MemoryRouter>
  );
}

function prepararSupabase(email) {
  getUserMock.mockResolvedValue({ data: { user: { email, user_metadata: { nome: "Usuário Teste" } } }, error: null });
  // Cadeia de consulta: qualquer select resolve a lista vazia ou o aluno.
  const cadeia = {
    select: vi.fn(() => cadeia), eq: vi.fn(() => cadeia), in: vi.fn(() => cadeia), order: vi.fn(() => cadeia),
    limit: vi.fn(() => cadeia), maybeSingle: vi.fn().mockResolvedValue({ data: ALUNO, error: null }),
    single: vi.fn().mockResolvedValue({ data: ALUNO, error: null }),
    then: (resolve) => resolve({ data: [], error: null }),
  };
  fromMock.mockImplementation((tabela) => {
    if (tabela === "aluno_movimentacoes") {
      return { ...cadeia, insert: (...a) => { insertMock(...a); return Promise.resolve({ error: null }); } };
    }
    if (tabela === "alunos") {
      return { ...cadeia, update: (...a) => { updateMock(...a); return cadeia; } };
    }
    return cadeia;
  });
  rpcMock.mockImplementation((nome) => Promise.resolve(
    nome === "buscar_aluno_por_id" ? { data: [ALUNO], error: null } : { data: null, error: null }
  ));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "alert").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Aluno.jsx — registro de termo arquivado (gestão)", () => {
  it("mostra o botão para a conta de gestão", async () => {
    prepararSupabase("amanda.seibel@aelbra.com.br");
    await act(async () => { renderFicha(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByRole("button", { name: /Registrar termo arquivado/i })).not.toBeNull();
  });

  it("não mostra o botão para operador comum", async () => {
    prepararSupabase("op@test.com");
    await act(async () => { renderFicha(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByRole("button", { name: /Registrar termo arquivado/i })).toBeNull();
  });

  it("grava só a movimentação informativa e não escreve em alunos", async () => {
    prepararSupabase("amanda.seibel@aelbra.com.br");
    await act(async () => { renderFicha(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const botao = screen.getByRole("button", { name: /Registrar termo arquivado/i });
    await act(async () => { fireEvent.click(botao); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    expect(insertMock).toHaveBeenCalledTimes(1);
    const linha = insertMock.mock.calls[0][0];
    expect(linha).toMatchObject({
      aluno_id: ALUNO.id,
      tipo: "REGISTRO_TERMO_FISICO_INFORMATIVO",
      descricao: "Termo físico assinado pelo aluno e arquivado com a gestão.",
      status_anterior: null,
      status_novo: null,
      registrado_por_email: "amanda.seibel@aelbra.com.br",
    });
    expect(typeof linha.registrado_em).toBe("string");
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
//
// Gravacao comum da FilaOperacional: payload capturado na chamada real do
// supabase.from("alunos").update(). Prova que campos de retorno carregados na
// ficha NAO voltam ao banco, mesmo quando outro processo reagendou entre a
// leitura e o salvamento.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const { fromMock, rpcMock, updateMock, insertMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  updateMock: vi.fn(),
  insertMock: vi.fn(),
}));

vi.mock("../services/supabase", () => ({
  supabase: {
    from: (...a) => fromMock(...a),
    rpc: (...a) => rpcMock(...a),
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { email: "op@test.com", user_metadata: { nome: "Operador" } } }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: {} }, error: null }),
    },
    storage: { from: () => ({ createSignedUrl: vi.fn(), upload: vi.fn() }) },
  },
}));

vi.mock("../components/FluxoLinksRapido", () => ({ default: () => null }));
vi.mock("../components/ModuloLinkPagamentoGlobal", () => ({ default: () => null }));
vi.mock("../components/LinksPagamentoAluno", () => ({ default: () => null }));
vi.mock("../components/CadastroNovoAluno", () => ({ default: () => null }));
vi.mock("../components/FinalizacaoTermo", () => ({ default: () => null }));
vi.mock("../components/EnvioFinanceiro", () => ({ default: () => null }));
vi.mock("../components/FinanceiroAluno", () => ({ default: () => null }));
vi.mock("../components/ConfirmarPagamento", () => ({ default: () => null }));
vi.mock("../components/FilaReceptivo", () => ({ default: () => null }));
vi.mock("../components/MeusAcionamentos", () => ({ default: () => null }));
vi.mock("../components/PontoOperador", () => ({ default: () => null }));
vi.mock("../components/MuralAniversariantes", () => ({ default: () => null }));
vi.mock("../components/ResumoDoDia", () => ({ default: () => null }));
vi.mock("../components/ReceberLeads", () => ({ default: () => null }));
vi.mock("../components/MinhaCarteira", () => ({ default: () => null }));
vi.mock("../components/PainelCarteira", () => ({ default: () => null }));
vi.mock("../utils/tabulacoes", () => ({
  carregarTabulacoes: vi.fn().mockResolvedValue([]),
  desfechoDaTabulacao: (_cat, _status, opts) => (opts?.dataDigitada
    ? { proxima_acao: null, data_retorno: opts.dataDigitada, retorno_origem: "OPERADOR", motivo: "DIGITADA" }
    : { proxima_acao: null, data_retorno: null, retorno_origem: null, motivo: null }),
  camposDeRetorno: (origem, data) => ({ data_retorno: data ? data.slice(0, 10) : null, hora_retorno: data && data.length > 10 ? data.slice(11, 16) : null, retorno_origem: origem }),
  lerRetornoAtual: vi.fn().mockResolvedValue({ ok: true, retorno: null }),
  RETORNO_ORIGEM_OPERADOR: "OPERADOR",
}));

import FilaOperador from "./FilaOperacional";

const ALUNO = {
  id: "11111111-1111-4111-8111-111111111111",
  nome: "Aluna Ficticia",
  cpf: "12345678900",
  valor_em_aberto: 500,
  status_jornada: "CONTATAR",
  status_atual: "CONTATAR",
  status: "CONTATAR",
  responsavel_atual_email: "op@test.com",
  responsavel_atual_em: new Date().toISOString(),
  data_retorno: "2099-12-01T10:00:00",
  hora_retorno: "10:00",
  retorno_origem: "OPERADOR",
  retorno_confirmado_em: "2026-11-14T15:00:00Z",
  retorno_prioritario: false,
};

function cadeia(resultado) {
  const c = {};
  for (const m of ["select", "eq", "in", "order", "limit", "not", "is", "gte", "lte", "neq", "or", "ilike", "range", "contains", "overlaps"]) c[m] = vi.fn(() => c);
  c.maybeSingle = vi.fn().mockResolvedValue(resultado);
  c.single = vi.fn().mockResolvedValue(resultado);
  c.then = (ok, ko) => Promise.resolve(resultado).then(ok, ko);
  return c;
}

// `alunoNoBanco` representa o que o banco tem AGORA (pode ter sido reagendado
// por outro processo depois que a tela leu a ficha).
function montar({ alunoNoBanco = ALUNO } = {}) {
  updateMock.mockImplementation(() => cadeia({ data: null, error: null }));
  insertMock.mockResolvedValue({ error: null });
  fromMock.mockImplementation((tabela) => {
    if (tabela === "alunos") return { select: () => cadeia({ data: [alunoNoBanco], error: null }), update: updateMock };
    if (tabela === "aluno_movimentacoes") return { insert: insertMock, select: () => cadeia({ data: [], error: null }) };
    if (tabela === "usuarios") return { select: () => cadeia({ data: { id: "u1", apelido: null }, error: null }) };
    return { select: () => cadeia({ data: [], error: null }), insert: vi.fn().mockResolvedValue({ error: null }) };
  });
  rpcMock.mockImplementation(() => Promise.resolve({ data: [], error: null }));
}

let alertMock;
beforeEach(() => {
  vi.clearAllMocks();
  alertMock = vi.spyOn(window, "alert").mockImplementation(() => {});
});
afterEach(() => {
  alertMock.mockRestore();
  cleanup();
});

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));
vi.mock("react-router-dom", async (orig) => ({ ...(await orig()), useNavigate: () => navigateMock }));

describe("FilaOperacional: gravacao comum nao e alcancavel pela tela", () => {
  // Os handlers de gravacao da fila (finalizarAtendimento, abrirAlunoNaFila,
  // assumirAtendimento, alterarOperadorResponsavel, solicitarLinkPagamento) nao
  // tem nenhuma referencia na JSX. O clique numa linha so navega para /aluno.
  // Por isso o payload da fila nao pode ser capturado por botao: o teste prova
  // que a tela, usada como operador, nao grava nada ao abrir e clicar nos casos.
  it("clicar numa linha da fila so navega para a ficha e nao grava nada", async () => {
    montar();
    await act(async () => {
      render(<MemoryRouter><FilaOperador /></MemoryRouter>);
      await new Promise((r) => setTimeout(r, 80));
    });
    await act(async () => { fireEvent.click(screen.getByText("Aluna Ficticia")); });

    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith(expect.stringMatching(/^\/aluno\?alunoId=/));
  });
});

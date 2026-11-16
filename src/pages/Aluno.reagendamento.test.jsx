// @vitest-environment jsdom
//
// Comportamento do retorno na ficha do aluno (Aluno.jsx), provado na pagina:
//   1. salvar sem Reagendar preserva a confirmacao ("Ja falei") e nao chama a RPC;
//   2. mudar data/hora sem Reagendar e gravacao comum: a data muda, a confirmacao
//      ("Ja falei") nao e tocada e nao ha RPC (contrato: so a RPC zera);
//   3. Reagendar com a MESMA data e hora chama agenda_reagendar_retorno;
//   4. falha da RPC: a ficha salva, o aviso diz que o reagendamento NAO foi
//      aplicado, e o checkbox continua marcado (nao anuncia sucesso);
//   5. checkbox reinicia depois de sucesso e ao trocar de aluno.
//
// Supabase mockado. Os mocks de tabulacao sao os da tela, mas camposDeRetorno
// devolve o formato real (data/hora/origem), senao o teste nao chega ao guard.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// A primeira importacao de Aluno.jsx (tela inteira, jsdom) passa de 5s no CI: sem folga, o primeiro
// teste estoura e deixa o DOM sujo para os seguintes. Aumenta so o limite de tempo; asserts intactos.
vi.setConfig({ testTimeout: 30000 });
// jsdom nao implementa scrollIntoView; a tela o chama ao trocar de aluno (listaResultadosRef).
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

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
  // Igual a tela real: data digitada vira DIGITADA (data_retorno = data digitada).
  desfechoDaTabulacao: (_cat, _status, opts) => (opts?.dataDigitada
    ? { proxima_acao: null, data_retorno: opts.dataDigitada, retorno_origem: "OPERADOR", motivo: "DIGITADA" }
    : { proxima_acao: null, data_retorno: null, retorno_origem: null, motivo: null }),
  retornoEhManual: vi.fn().mockReturnValue(false),
  camposDeRetorno: (origem, data) => ({ data_retorno: data ? data.slice(0, 10) : null, hora_retorno: data && data.length > 10 ? data.slice(11, 16) : null, retorno_origem: origem }),
  lerRetornoAtual: vi.fn().mockResolvedValue({ ok: true, retorno: null }),
  RETORNO_ORIGEM_OPERADOR: "OPERADOR",
  tabulacaoDisponivel: () => true,
}));
vi.mock("../utils/retornoOrigem", () => ({ ehOrigemDoOperador: (o) => o === "OPERADOR" }));
vi.mock("jspdf", () => ({ default: class { text() {} save() {} setFont() {} setFontSize() {} setTextColor() {} setDrawColor() {} line() {} splitTextToSize() { return []; } addPage() {} } }));

import Alunos from "./Aluno";

const FUTURO = "2099-12-01";
const ALUNO = {
  id: "11111111-1111-4111-8111-111111111111",
  nome: "Aluna Ficticia",
  cpf: "12345678900",
  valor_em_aberto: 500,
  responsavel_atual_email: "op@test.com",
  status_jornada: "EM_ATENDIMENTO",
  status_atual: "EM_ATENDIMENTO",
  status: "EM_ATENDIMENTO",
  data_retorno: `${FUTURO}T10:00:00`,
  hora_retorno: "10:00",
  retorno_origem: "OPERADOR",
  retorno_confirmado_em: "2026-11-14T15:00:00Z",
  retorno_prioritario: false,
};
const OUTRO = { ...ALUNO, id: "22222222-2222-4222-8222-222222222222", nome: "Outro Aluno", retorno_confirmado_em: null, data_retorno: null, hora_retorno: null, retorno_origem: null };

function cadeia(resultado) {
  const c = {};
  for (const m of ["select", "eq", "in", "order", "limit", "not", "is", "gte", "lte", "neq"]) c[m] = vi.fn(() => c);
  c.maybeSingle = vi.fn().mockResolvedValue(resultado);
  c.single = vi.fn().mockResolvedValue(resultado);
  c.then = (ok, ko) => Promise.resolve(resultado).then(ok, ko);
  return c;
}
function montarSupabase({ erroRpcReagendar = null, alunos = [ALUNO] } = {}) {
  updateMock.mockImplementation(() => cadeia({ data: null, error: null }));
  insertMock.mockResolvedValue({ error: null });
  fromMock.mockImplementation((tabela) => {
    if (tabela === "aluno_movimentacoes") {
      return { insert: insertMock, select: () => cadeia({ data: [], error: null }) };
    }
    if (tabela === "alunos") {
      return { update: updateMock, select: () => cadeia({ data: alunos, error: null }) };
    }
    return { select: () => cadeia({ data: [], error: null }) };
  });
  rpcMock.mockImplementation((nome, args) => {
    if (nome === "buscar_aluno_por_id") {
      const alvo = alunos.find((a) => a.id === args?.p_id) || alunos[0];
      return Promise.resolve({ data: [alvo], error: null });
    }
    if (nome === "buscar_aluno") return Promise.resolve({ data: alunos, error: null });
    if (nome === "agenda_reagendar_retorno") return Promise.resolve({ data: null, error: erroRpcReagendar });
    return Promise.resolve({ data: null, error: null });
  });
}

function abrirFicha(aluno = ALUNO) {
  window.history.replaceState(null, "", `/aluno?alunoId=${aluno.id}`);
  return act(async () => {
    render(
      <MemoryRouter initialEntries={[`/aluno?alunoId=${aluno.id}`]}>
        <Alunos />
      </MemoryRouter>
    );
    await new Promise((r) => setTimeout(r, 60));
  });
}

const campoData = () => document.querySelector('input[type="datetime-local"]');
const checkboxReagendar = () => screen.getByText(/Reagendar \(novo compromisso/i).closest("label").querySelector("input");
function botaoAtualizar() {
  // Botao "Atualizar" da linha de acoes da ficha (ao lado de "Solicitar link").
  const botoes = screen.getAllByRole("button", { name: "Atualizar" });
  const alvo = botoes.find((b) => b.parentElement?.textContent?.includes("Solicitar link"));
  if (!alvo) throw new Error("botao Atualizar da ficha nao encontrado");
  return alvo;
}
async function clicarAtualizar() {
  await act(async () => { fireEvent.click(botaoAtualizar()); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

let alertMock;
beforeEach(() => {
  vi.clearAllMocks();
  alertMock = vi.spyOn(window, "alert").mockImplementation(() => {});
  montarSupabase();
});
afterEach(() => {
  alertMock.mockRestore();
  cleanup();
});

const chamadasRpc = (nome) => rpcMock.mock.calls.filter((c) => c[0] === nome);

describe("Aluno.jsx: retorno e Reagendar", () => {
  it("salvar sem Reagendar preserva a confirmacao: payload sem campos de confirmacao e sem RPC", async () => {
    await abrirFicha();
    expect(campoData().value).toMatch(new RegExp(`^${FUTURO}`));
    expect(checkboxReagendar().checked).toBe(false);

    await clicarAtualizar();

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const payload = updateMock.mock.calls[0][0];
    expect(payload).not.toHaveProperty("retorno_confirmado_em");
    expect(payload).not.toHaveProperty("data_retorno");
    expect(payload).not.toHaveProperty("hora_retorno");
    expect(payload).not.toHaveProperty("retorno_origem");
    expect(chamadasRpc("agenda_reagendar_retorno")).toHaveLength(0);
  });

  it("mudar data sem Reagendar grava a data comum, sem recusa, sem RPC e sem tocar na confirmacao (contrato)", async () => {
    await abrirFicha();
    await act(async () => {
      fireEvent.change(campoData(), { target: { value: "2099-12-05T09:00" } });
    });

    await clicarAtualizar();

    expect(alertMock).not.toHaveBeenCalledWith(expect.stringMatching(/marque Reagendar/));
    expect(updateMock).toHaveBeenCalledTimes(1);
    const payload = updateMock.mock.calls[0][0];
    expect(payload.data_retorno).toMatch(/^2099-12-05/);
    expect(payload).not.toHaveProperty("retorno_confirmado_em");
    expect(chamadasRpc("agenda_reagendar_retorno")).toHaveLength(0);
  });

  it("Reagendar com a MESMA data e hora chama a RPC com data e hora, e nao escreve retorno na gravacao comum", async () => {
    await abrirFicha();
    await act(async () => { fireEvent.click(checkboxReagendar()); });

    await clicarAtualizar();

    const rpc = chamadasRpc("agenda_reagendar_retorno");
    expect(rpc).toHaveLength(1);
    expect(rpc[0][1]).toEqual({
      p_aluno_id: ALUNO.id,
      p_data: FUTURO,
      p_hora: "10:00",
      p_prioritario: false,
    });
    const payload = updateMock.mock.calls[0]?.[0] || {};
    expect(payload).not.toHaveProperty("data_retorno");
    expect(payload).not.toHaveProperty("retorno_confirmado_em");
  });

  it("falha da RPC: avisa que o reagendamento NAO foi aplicado, nada e gravado (sem movimentacao nem ficha) e mantem o checkbox marcado", async () => {
    montarSupabase({ erroRpcReagendar: { message: "Sem permissao para reagendar o retorno deste aluno" } });
    await abrirFicha();
    await act(async () => { fireEvent.click(checkboxReagendar()); });

    await clicarAtualizar();

    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(alertMock).toHaveBeenCalledWith(expect.stringMatching(/Reagendamento NAO foi aplicado\. Nada foi salvo/));
    expect(alertMock).not.toHaveBeenCalledWith(expect.stringMatching(/Atendimento assumido|sucesso/i));
    expect(checkboxReagendar().checked).toBe(true);
  });

  it("checkbox reinicia depois de sucesso", async () => {
    await abrirFicha();
    await act(async () => { fireEvent.click(checkboxReagendar()); });
    await clicarAtualizar();

    expect(chamadasRpc("agenda_reagendar_retorno")).toHaveLength(1);
    await waitFor(() => expect(checkboxReagendar().checked).toBe(false));
  });

  it("Reagendar sem data e recusado antes de qualquer escrita (sem movimentacao, sem update, sem RPC)", async () => {
    await abrirFicha();
    await act(async () => {
      fireEvent.change(campoData(), { target: { value: "" } });
    });
    await act(async () => {
      fireEvent.click(checkboxReagendar());
    });

    await clicarAtualizar();

    expect(alertMock).toHaveBeenCalledWith(expect.stringMatching(/Informe a data/));
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(chamadasRpc("agenda_reagendar_retorno")).toHaveLength(0);
  });

  it("checkbox reinicia ao trocar de aluno (sem reagendar o aluno anterior)", async () => {
    montarSupabase({ alunos: [ALUNO, OUTRO] });
    await abrirFicha();
    await act(async () => { fireEvent.click(checkboxReagendar()); });
    expect(checkboxReagendar().checked).toBe(true);

    // Troca de aluno pela busca real da tela: pesquisa e abre o outro aluno.
    const busca = screen.getByPlaceholderText(/Digite nome, CPF ou telefone/i);
    await act(async () => { fireEvent.change(busca, { target: { value: "Aluna" } }); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Pesquisar/i })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const alvo = screen.getByText("Outro Aluno").closest("button") || screen.getByText("Outro Aluno");
    await act(async () => { fireEvent.click(alvo); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    expect(screen.getByText(/Atendimento do aluno/i)).toBeTruthy();
    expect(checkboxReagendar().checked).toBe(false);
  });
});

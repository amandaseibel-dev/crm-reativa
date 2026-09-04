// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// Dublês: o que se prova aqui é a TABULAÇÃO que o envio do e-mail grava --
// tem de ser a mesma "Mensagem enviada" do botão rápido da Minha Carteira,
// e a tela-mãe tem de ser avisada para não gravar "A contatar" por cima.
const updateMock = vi.fn();
const insertMock = vi.fn();
// Catálogo de tabulações: é ele quem manda no prazo (5 dias úteis = a mesma
// data da semana seguinte), não o `dias_retorno` da arte.
const CATALOGO = [
  { codigo: "MENSAGEM_ENVIADA", rotulo: "Mensagem enviada", ativa: true, ordem: 20, grupo: "CONTATO", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 5, proxima_acao: "CONTATAR" },
];
const TEMPLATES = [
  {
    chave: "aviso_mensalidades_aberto", situacao: "Aviso de mensalidades em aberto",
    assunto: "Aviso {{nome}}", corpo_html: "<p>Oi {{nome}}</p>", corpo_texto: "Oi {{nome}}",
    permite_anexo: false, ordem: 1, dias_retorno: 2, novo: false,
  },
];
vi.mock("../services/supabase", () => ({
  supabase: {
    auth: {
      getUser: async () => ({
        data: { user: { email: "cobranca03@aelbra.com.br", user_metadata: { nome: "Olga" } } },
      }),
    },
    from: (tabela) => {
      if (tabela === "email_templates") {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: TEMPLATES }) }) }) };
      }
      if (tabela === "tabulacoes") {
        return { select: () => ({ order: () => ({ order: async () => ({ data: CATALOGO, error: null }) }) }) };
      }
      if (tabela === "alunos") return { update: (campos) => ({ eq: (col, id) => updateMock(campos, col, id) }) };
      if (tabela === "aluno_movimentacoes") return { insert: (linha) => insertMock(linha) };
      throw new Error("tabela inesperada: " + tabela);
    },
  },
}));

import EmailAlunoUnificado from "./EmailAlunoUnificado";

const ALUNO = { id: "aluno-1", nome: "Ana Teste", email: "ana@x.com", status_atual: "CONTATAR", valor_em_aberto: 100 };

async function abrirGmailPara(aluno, onTabulado) {
  await act(async () => { render(<EmailAlunoUnificado aluno={aluno} onTabulado={onTabulado} />); });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Abrir no Gmail (arte copiada)" }));
  });
}

const openOriginal = window.open;

beforeEach(() => {
  updateMock.mockReset();
  insertMock.mockReset();
  updateMock.mockResolvedValue({ error: null });
  insertMock.mockResolvedValue({ error: null });
  window.open = vi.fn();
  // Sexta-feira 04/09/2026, de manhã: +5 dias úteis = sexta 11/09.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 4, 10, 0, 0));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.open = openOriginal;
});

describe("EmailAlunoUnificado", () => {
  it('abrir o Gmail tabula "Mensagem enviada" (igual ao botão rápido) e avisa a tela-mãe', async () => {
    const onTabulado = vi.fn();
    await abrirGmailPara(ALUNO, onTabulado);

    expect(window.open).toHaveBeenCalledTimes(1);
    expect(String(window.open.mock.calls[0][0])).toContain("to=ana%40x.com");

    // a ficha: status da mensagem, retorno pelo prazo da arte, origem automática
    const [campos, coluna, id] = updateMock.mock.calls[0];
    expect([coluna, id]).toEqual(["id", "aluno-1"]);
    expect(campos).toMatchObject({
      status_atual: "MENSAGEM_ENVIADA",
      status_jornada: "MENSAGEM_ENVIADA",
      proxima_acao: "CONTATAR",
      data_retorno: "2026-09-11",
      retorno_origem: "AUTOMATICO",
      status_acionamento: "E-mail enviado - Aviso de mensalidades em aberto",
    });
    expect(campos.data_ultimo_acionamento).toBeTruthy();

    // o histórico diz de onde para onde foi
    const [linha] = insertMock.mock.calls[0];
    expect(linha).toMatchObject({
      aluno_id: "aluno-1",
      tipo: "ACAO_MASSIVA_EXTERNA_EMAIL",
      status_anterior: "CONTATAR",
      status_novo: "MENSAGEM_ENVIADA",
    });
    expect(linha.descricao).toContain('tabulado como "Mensagem enviada", retorno 11/09/2026 (5 dias úteis)');

    // a tela-mãe recebe o que foi gravado, para o select não ficar com o status velho
    expect(onTabulado).toHaveBeenCalledWith(
      expect.objectContaining({ status: "MENSAGEM_ENVIADA", dataRetorno: "2026-09-11", mantido: false })
    );
    expect(screen.getByText(/Tabulado como "Mensagem enviada" — retorno em 11\/09\/2026 \(5 dias úteis\)/)).toBeTruthy();
  });

  it("compromisso futuro que o operador já marcou não é apagado pelo e-mail", async () => {
    const onTabulado = vi.fn();
    await abrirGmailPara({ ...ALUNO, data_retorno: "2026-09-25", retorno_origem: "OPERADOR" }, onTabulado);
    const [campos] = updateMock.mock.calls[0];
    expect(campos).toMatchObject({ status_atual: "MENSAGEM_ENVIADA", data_retorno: "2026-09-25", retorno_origem: "OPERADOR" });
    expect(screen.getByText(/retorno em 25\/09\/2026 \(data que você já tinha marcado\)/)).toBeTruthy();
  });

  it("caso fora da mão do operador (aguardando baixa) registra o e-mail sem trocar a tabulação", async () => {
    const onTabulado = vi.fn();
    await abrirGmailPara({ ...ALUNO, status_atual: "AGUARDANDO_BAIXA" }, onTabulado);

    const [campos] = updateMock.mock.calls[0];
    expect(campos.status_atual).toBeUndefined();
    expect(campos.status_jornada).toBeUndefined();
    expect(campos.data_retorno).toBeUndefined();
    expect(campos.data_ultimo_acionamento).toBeTruthy();

    const [linha] = insertMock.mock.calls[0];
    expect(linha).toMatchObject({ status_anterior: "AGUARDANDO_BAIXA", status_novo: "AGUARDANDO_BAIXA" });
    expect(onTabulado).toHaveBeenCalledWith(expect.objectContaining({ mantido: true, status: "AGUARDANDO_BAIXA" }));
    expect(screen.getByText(/A tabulação "Aguardando baixa" foi mantida/)).toBeTruthy();
  });

  it("quando o banco recusa o status, avisa na tela e não finge que tabulou", async () => {
    updateMock.mockResolvedValue({ error: { message: "RLS negou" } });
    const onTabulado = vi.fn();
    await abrirGmailPara(ALUNO, onTabulado);

    expect(onTabulado).not.toHaveBeenCalled();
    const [linha] = insertMock.mock.calls[0];
    expect(linha.status_novo).toBeUndefined();
    expect(linha.descricao).toContain("sem tabular");
    expect(screen.getByText(/NÃO consegui tabular "Mensagem enviada" \(RLS negou\)/)).toBeTruthy();
  });
});

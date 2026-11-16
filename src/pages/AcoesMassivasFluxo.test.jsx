// @vitest-environment jsdom
// Fluxo da exportação na página, com xlsx REAL. Limite: aqui a gravação do arquivo
// (XLSX.writeFile) é INTERCEPTADA pelo teste (não há download de verdade no jsdom).
// Download real no navegador não é coberto por este arquivo. A RPC é um dublê com
// resposta fictícia; nada toca produção.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, waitFor } from "@testing-library/react";
import * as XLSX from "xlsx";

const rpcMock = vi.fn();
const controle = { falhaGravacaoAte: 0, gravacoes: [], rpcErro: null };

vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (...a) => rpcMock(...a),
    auth: { getUser: async () => ({ data: { user: { email: "gestao@reativa" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  },
}));
vi.mock("../components/BotaoAtualizar", () => ({
  default: ({ onClick, rotulo }) => <button type="button" onClick={onClick}>{rotulo}</button>,
}));
vi.mock("../components/PenetracaoPorAno", () => ({ default: () => null }));
vi.mock("xlsx", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    writeFile: (livro, nome) => {
      if (controle.falhaGravacaoAte > 0) {
        controle.falhaGravacaoAte -= 1;
        throw Object.assign(new Error("falha simulada ao gravar"), { code: "EGRAVA" });
      }
      controle.gravacoes.push({ livro, nome });
    },
  };
});

import AcoesMassivas from "./AcoesMassivas";

const ELEGIVEIS = [
  { id: "11111111-1111-4111-8111-111111111111", nome: "Aluno Teste Um", situacao_academica: "Matriculado",
    curso: "EAD", unidade: "CANOAS", tem_telefone: true, tem_email: true,
    telefone_mascarado: "••••0001", email_mascarado: "a•••@teste.local", valor: 500 },
  { id: "22222222-2222-4222-8222-222222222222", nome: "Aluno Teste Dois", situacao_academica: "Matriculado",
    curso: "EAD", unidade: "CANOAS", tem_telefone: true, tem_email: true,
    telefone_mascarado: "••••0002", email_mascarado: "b•••@teste.local", valor: 800 },
];
const CONTATOS = [
  { aluno_id: ELEGIVEIS[0].id, nome: "Aluno Teste Um", telefone: "51900000001", email: "um@teste.local" },
  { aluno_id: ELEGIVEIS[1].id, nome: "Aluno Teste Dois", telefone: "51900000002", email: "dois@teste.local" },
];
const RESPONSAVEIS = [
  { email: "SEM_RESPONSAVEL", nome: "Sem responsável", classe: "SEM_RESPONSAVEL", casos: 1, acordos: 0, acordos_ativos: 0 },
  { email: "cobranca05@teste.local", nome: "Luana", classe: "OPERADOR_ATIVO", casos: 2, acordos: 0, acordos_ativos: 0 },
];

beforeEach(() => {
  controle.falhaGravacaoAte = 0;
  controle.gravacoes = [];
  controle.rpcErro = null;
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (nome, args) => {
    if (nome === "acoes_massivas_filtros") {
      return { data: { unidades: ["CANOAS"], cursos: ["EAD"], situacoes_academicas: ["Matriculado"],
                       operadores: [{ email: "cobranca05@teste.local", nome: "Luana" }] } };
    }
    if (nome === "acoes_massivas_responsaveis") return { data: RESPONSAVEIS };
    if (nome === "acoes_massivas_previa") {
      return { data: {
        elegiveis: ELEGIVEIS, excluidos_confirmacao: [],
        operador_email: String(args.p_operador_email ?? "").toLowerCase(),
        tipo_cobranca: args.p_tipo_cobranca ?? "REGRA_ANTERIOR", previa_id: "previa-teste-1",
        resumo: { solicitado: args.p_limite, universo_base: 2, disponiveis: 2, elegiveis: 2, selecionado: 2,
                  indisponiveis: 0, motivos: {}, com_responsavel: 0, com_fidelizacao_ativa: 0, menos_que_solicitado: false,
                  fora_do_filtro_acionamento: 0, filtros: {} },
        total_elegivel_filtros: 2, contagem_tipo: null,
      } };
    }
    if (nome === "acoes_massivas_exportar") {
      if (controle.rpcErro) return { data: null, error: controle.rpcErro };
      return { data: {
        lote_id: "lote-teste-1", exportados: 2, selecionados: 2, registrados: 2, registro_automatico: true,
        ids_exportados: ELEGIVEIS.map((e) => e.id), excluidos_confirmacao: 0,
        operador_email: "caso:cobranca05@teste.local", tipo_cobranca: "MENSALIDADES", contatos: CONTATOS,
      } };
    }
    return { data: [] };
  });
});
afterEach(() => { cleanup(); controle.falhaGravacaoAte = 0; });

async function montarEBuscar() {
  await act(async () => { render(<AcoesMassivas />); });
  await screen.findByLabelText("Matriculado");
  await screen.findByTestId("resp-caso");
  await act(async () => { fireEvent.click(document.getElementById("resp-caso-cobranca05@teste.local")); });
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Tipo de cobrança"), { target: { value: "MENSALIDADES" } });
  });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Buscar/ })); });
  await waitFor(() => expect(rpcMock.mock.calls.some(([n]) => n === "acoes_massivas_previa")).toBe(true));
}
const exportacoes = () => rpcMock.mock.calls.filter(([n]) => n === "acoes_massivas_exportar").length;
async function gerarPlanilha() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Exportar planilha/ })); });
}

describe("Exportação — fluxo da página (xlsx real; gravação interceptada no jsdom)", () => {
  it("exporta: uma RPC, um arquivo com o nome da ação e o conteúdo dos contatos", async () => {
    await montarEBuscar();
    await gerarPlanilha();
    await waitFor(() => expect(controle.gravacoes.length).toBe(1));
    expect(exportacoes()).toBe(1);
    const { livro, nome } = controle.gravacoes[0];
    expect(nome).toMatch(/^acao-massiva-whatsapp-.*\.xlsx$/);
    const matriz = XLSX.utils.sheet_to_json(livro.Sheets["Ação Massiva"], { header: 1 });
    expect(matriz).toEqual([
      ["Nome do aluno", "Telefone"],
      ["Aluno Teste Um", "5551900000001"],
      ["Aluno Teste Dois", "5551900000002"],
    ]);
  });

  it("arquivo falha depois do registro: lote registrado, arquivo não baixado; 'Baixar de novo' não exporta de novo", async () => {
    controle.falhaGravacaoAte = 1;
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    await montarEBuscar();
    await gerarPlanilha();
    await waitFor(() => expect(screen.getByText(/Lote registrado, arquivo não baixado/)).toBeTruthy());
    expect(exportacoes()).toBe(1);
    expect(controle.gravacoes.length).toBe(0);
    // não diz que a planilha foi exportada
    expect(screen.queryByText(/Lote registrado e planilha baixada/)).toBeNull();
    // após o arquivo falhar, nova exportação fica bloqueada nesta tela (regra desta PR)
    expect(screen.getByRole("button", { name: /Exportar planilha/ }).disabled).toBe(true);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Baixar planilha novamente/ })); });
    await waitFor(() => expect(controle.gravacoes.length).toBe(1));
    expect(exportacoes()).toBe(1);
    // a mensagem de falha some; a exportação não foi repetida
    expect(screen.queryByText(/Lote registrado, arquivo não baixado/)).toBeNull();
    avisos.mockRestore();
  });

  it("resultado incerto (sem código de validação): bloqueia nova exportação até conferir o histórico", async () => {
    controle.rpcErro = Object.assign(new Error("Failed to fetch"), {});
    const erros = vi.spyOn(console, "error").mockImplementation(() => {});
    await montarEBuscar();
    await gerarPlanilha();
    await waitFor(() => expect(screen.getAllByText(/Resultado do registro desconhecido/).length).toBeGreaterThan(0));
    const exportar = screen.getByRole("button", { name: /Exportar planilha/ });
    expect(exportar.disabled).toBe(true);
    // não existe mais liberação por caixa de confirmação; recarregar remove só o bloqueio local
    expect(screen.queryByRole("button", { name: /Liberar nova exportação/ })).toBeNull();
    expect(controle.gravacoes.length).toBe(0);
    // o log não traz dados pessoais
    const registro = erros.mock.calls.map((c) => String(c[0]) + JSON.stringify(c[1] ?? {})).join("\n");
    expect(registro).not.toMatch(/Aluno Teste|@teste\.local|5190000/);
    erros.mockRestore();
  });

  it("validação recusada (código 22023): nada registrado e a exportação continua disponível", async () => {
    controle.rpcErro = Object.assign(new Error("Selecao diverge da previa autorizada. Gere a previa de novo."), { code: "22023" });
    const erros = vi.spyOn(console, "error").mockImplementation(() => {});
    await montarEBuscar();
    await gerarPlanilha();
    await waitFor(() => expect(screen.getByText(/recusada pela validação/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Exportar planilha/ }).disabled).toBe(false);
    expect(controle.gravacoes.length).toBe(0);
    erros.mockRestore();
  });

  it("exportação concluída bloqueia nova exportação até nova prévia", async () => {
    await montarEBuscar();
    await gerarPlanilha();
    await waitFor(() => expect(controle.gravacoes.length).toBe(1));
    expect(screen.getByRole("button", { name: /Exportar planilha/ }).disabled).toBe(true);
    // nova prévia (novo recorte) libera a exportação; a regra de recência do banco continua valendo
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Buscar/ })); });
    await waitFor(() => expect(screen.getByRole("button", { name: /Exportar planilha/ }).disabled).toBe(false));
  });

  it("sucesso seguido de falha no 'Baixar de novo': nao deixa 'Lote registrado' ao lado do erro", async () => {
    await montarEBuscar();
    await gerarPlanilha();
    await waitFor(() => expect(controle.gravacoes.length).toBe(1));
    expect(screen.getByText(/Lote registrado: 2 aluno/)).toBeTruthy();
    controle.falhaGravacaoAte = 1;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Baixar planilha novamente/ })); });
    await waitFor(() => expect(screen.getByText(/Lote registrado, arquivo não baixado/)).toBeTruthy());
    expect(screen.queryByText(/Lote registrado: 2 aluno/)).toBeNull();
    expect(exportacoes()).toBe(1);
  });

  it("falha depois de um sucesso anterior: nao mantem 'Lote registrado' antigo ao lado da falha atual", async () => {
    await montarEBuscar();
    await gerarPlanilha();
    await waitFor(() => expect(screen.getByText(/Lote registrado: 2 aluno/)).toBeTruthy());
    // nova previa libera a exportacao (regra desta PR); a proxima tentativa falha por validacao
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Buscar/ })); });
    await waitFor(() => expect(screen.getByRole("button", { name: /Exportar planilha/ }).disabled).toBe(false));
    controle.rpcErro = Object.assign(new Error("Selecao diverge da previa autorizada. Gere a previa de novo."), { code: "22023" });
    await gerarPlanilha();
    await waitFor(() => expect(screen.getByText(/recusada pela validação/)).toBeTruthy());
    expect(screen.queryByText(/Lote registrado: 2 aluno/)).toBeNull();
    expect(controle.gravacoes.length).toBe(1);
  });

  it("falha de transporte depois de um sucesso anterior: fica resultado incerto, sem sucesso antigo", async () => {
    await montarEBuscar();
    await gerarPlanilha();
    await waitFor(() => expect(screen.getByText(/Lote registrado: 2 aluno/)).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Buscar/ })); });
    await waitFor(() => expect(screen.getByRole("button", { name: /Exportar planilha/ }).disabled).toBe(false));
    controle.rpcErro = Object.assign(new Error("Failed to fetch"), {});
    await gerarPlanilha();
    await waitFor(() => expect(screen.getAllByText(/Resultado do registro desconhecido/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Lote registrado: 2 aluno/)).toBeNull();
    expect(screen.getByRole("button", { name: /Exportar planilha/ }).disabled).toBe(true);
  });
});

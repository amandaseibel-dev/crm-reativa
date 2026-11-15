// @vitest-environment jsdom
// Geração e download da planilha da exportação, com a biblioteca xlsx REAL.
// Só a gravação (writeFile) é interceptada, para ler de volta o workbook e
// conferir o conteúdo. A RPC é um dublê com resposta fictícia: nada toca produção.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, waitFor } from "@testing-library/react";
import * as XLSX from "xlsx";

const rpcMock = vi.fn();
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

const gravacoes = [];
vi.mock("xlsx", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    writeFile: (livro, nome) => {
      if (globalThis.__falhaGravacao) throw Object.assign(new Error("falha simulada ao gravar"), { code: "EGRAVA" });
      gravacoes.push({ livro, nome });
    },
  };
});

import AcoesMassivas from "./AcoesMassivas";

// Resposta fictícia da prévia e da exportação (dados inventados).
const ELEGIVEIS = [
  { id: "11111111-1111-4111-8111-111111111111", nome: "Aluno Teste Um", situacao_academica: "Matriculado",
    curso: "EAD", unidade: "CANOAS", tem_telefone: true, tem_email: true,
    telefone_mascarado: "••••0001", email_mascarado: "a•••@teste.local", valor: 500 },
  { id: "22222222-2222-4222-8222-222222222222", nome: "Aluno Teste Dois", situacao_academica: "Matriculado",
    curso: "EAD", unidade: "CANOAS", tem_telefone: true, tem_email: true,
    telefone_mascarado: "••••0002", email_mascarado: "b•••@teste.local", valor: 800 },
];
const CONTATOS_FICTICIOS = [
  { aluno_id: ELEGIVEIS[0].id, nome: "Aluno Teste Um", telefone: "51900000001", email: "um@teste.local" },
  { aluno_id: ELEGIVEIS[1].id, nome: "Aluno Teste Dois", telefone: "51900000002", email: "dois@teste.local" },
];
const RESPONSAVEIS = [
  { email: "SEM_RESPONSAVEL", nome: "Sem responsável", classe: "SEM_RESPONSAVEL", casos: 1, acordos: 0, acordos_ativos: 0 },
  { email: "cobranca05@teste.local", nome: "Luana", classe: "OPERADOR_ATIVO", casos: 2, acordos: 0, acordos_ativos: 0 },
];

let exportarErro = null;
beforeEach(() => {
  gravacoes.length = 0;
  globalThis.__falhaGravacao = false;
  exportarErro = null;
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
      if (exportarErro) return { data: null, error: exportarErro };
      return { data: {
        lote_id: "lote-teste-1", exportados: 2, selecionados: 2, registrados: 2, registro_automatico: true,
        ids_exportados: ELEGIVEIS.map((e) => e.id), excluidos_confirmacao: 0, operador_email: "caso:cobranca05@teste.local",
        tipo_cobranca: "MENSALIDADES", contatos: CONTATOS_FICTICIOS,
      } };
    }
    return { data: [] };
  });
});
afterEach(() => { cleanup(); globalThis.__falhaGravacao = false; });

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
async function gerarPlanilha() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Exportar planilha/ })); });
}

describe("Ações Massivas — geração e download da planilha (xlsx real)", () => {
  it("grava um .xlsx com o nome da ação e o conteúdo dos contatos devolvidos pelo banco", async () => {
    await montarEBuscar();
    await gerarPlanilha();
    await waitFor(() => expect(gravacoes.length).toBe(1));

    const { livro, nome } = gravacoes[0];
    expect(nome).toMatch(/^acao-massiva-whatsapp-.*-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(livro.SheetNames).toEqual(["Ação Massiva"]);
    const matriz = XLSX.utils.sheet_to_json(livro.Sheets["Ação Massiva"], { header: 1 });
    expect(matriz).toEqual([
      ["Nome do aluno", "Telefone"],
      ["Aluno Teste Um", "5551900000001"],
      ["Aluno Teste Dois", "5551900000002"],
    ]);
  });

  it("falha ao gravar o arquivo: a etapa é 'arquivo' e o banco já registrou (sem mensagem de erro de RPC)", async () => {
    globalThis.__falhaGravacao = true;
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    const erros = vi.spyOn(console, "error").mockImplementation(() => {});
    await montarEBuscar();
    await gerarPlanilha();
    await waitFor(() => expect(avisos.mock.calls.some(([m]) => String(m).includes("etapa=arquivo"))).toBe(true));
    expect(avisos.mock.calls.map((c) => String(c[0])).join("\n")).toContain("codigo=EGRAVA");
    expect(erros.mock.calls.length).toBe(0);
    expect(screen.queryByText(/Erro ao exportar planilha/)).toBeNull();
    avisos.mockRestore();
    erros.mockRestore();
  });

  it("erro da RPC: a mensagem diz que a falha foi no banco e nada é gravado", async () => {
    exportarErro = Object.assign(new Error("Selecao diverge da previa autorizada. Gere a previa de novo."), { code: "22023" });
    const erros = vi.spyOn(console, "error").mockImplementation(() => {});
    await montarEBuscar();
    await gerarPlanilha();
    await waitFor(() => expect(screen.getByText(/Erro ao exportar planilha \(banco\)/)).toBeTruthy());
    expect(gravacoes.length).toBe(0);
    const registro = erros.mock.calls.map((c) => String(c[0])).join("\n");
    expect(registro).toContain("etapa=banco");
    expect(registro).toContain("codigo=22023");
    // Nada de nome, telefone, e-mail ou ids de aluno no log.
    expect(registro).not.toMatch(/Aluno Teste|@teste\.local|5190000/);
    erros.mockRestore();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import ComposicaoAcademicaDoSaldo from "./ComposicaoAcademicaDoSaldo";

// O que se prova aqui é a COMPOSIÇÃO FINANCEIRA do saldo em aberto por status
// acadêmico — o bloco que substituiu "Alunos por status" e o card "Status
// acadêmico por safra", que eram quantitativos e diziam a mesma coisa.
//
// Nenhuma conta acontece no front: o dublê devolve o payload como a RPC o
// entrega, e a única conta do desenho é o share de cada linha sobre o total que
// a própria RPC mandou.
//
// Os totais de 2024 abaixo são os validados pela gestão: 1.976 alunos, 6.367
// títulos e R$ 3.675.095,03 de saldo, dos quais R$ 1.964.708,62 (53,46%) estão
// sem situação acadêmica importada.
const C_2024 = {
  recorte: "2024",
  natureza: "COBERTURA_HISTORICA",
  fonte: "acordos_titulos + serie da Prime, ao vivo",
  universo_em_aberto: "saldo sem acordo ativo (balde \"em aberto\" das seis linhas)",
  gerado_em: "2026-10-07T19:30:00Z",
  total: { alunos: 1976, titulos: 6367, valor: 3675095.03 },
  linhas: [
    { status: "(sem situação importada)", alunos: 806, titulos: 2502, valor: 1964708.62 },
    { status: "Término do Contrato", alunos: 382, titulos: 1200, valor: 700000.00 },
    { status: "Formado", alunos: 152, titulos: 570, valor: 380060.92 },
    { status: "Aguardando Matrícula", alunos: 1, titulos: 2, valor: 1200.00 },
    { status: "Matriculado Curso Normal", alunos: 3, titulos: 8, valor: 4000.00 },
    { status: "Desvinculado", alunos: 632, titulos: 2085, valor: 625125.49 },
  ],
  conferencia: {
    total_valor: 3675095.03, soma_das_linhas: 3675095.03, diferenca: 0, fecha: true,
    titulos_total: 6367, titulos_soma: 6367,
  },
  fonte_academica: { importacao_atualizada_em: "2026-08-04T15:19:51Z" },
};

const C_2026_1 = {
  ...C_2024,
  recorte: "2026/1",
  natureza: "CARTEIRA_CONSOLIDADA",
  fonte: "carteira_2026_1_classificar() ao vivo",
  universo_em_aberto: "inadimplencia + em_validacao",
  total: { alunos: 2522, titulos: 7810, valor: 9931064.45 },
  linhas: [{ status: "Matriculado Curso Normal", alunos: 2522, titulos: 7810, valor: 9931064.45 }],
  conferencia: {
    total_valor: 9931064.45, soma_das_linhas: 9931064.45, diferenca: 0, fecha: true,
    titulos_total: 7810, titulos_soma: 7810,
  },
};

const responder = (payload, error = null) =>
  rpcMock.mockImplementation(() => Promise.resolve({ data: payload, error }));

// `toLocaleString` com BRL separa "R$" do número com espaço NÃO quebrável
// (U+00A0). `getByText` normaliza isso sozinho; `textContent` não — e é por
// textContent que se confere uma LINHA inteira da tabela.
const txt = (el) => el.textContent.replace(/\u00a0/g, " ");

const montar = (props = { ano: "2024", semestre: null }) =>
  act(async () => { render(<ComposicaoAcademicaDoSaldo {...props} />); });

beforeEach(() => { rpcMock.mockReset(); responder(C_2024); });
afterEach(() => cleanup());

describe("Composição do saldo em aberto por status acadêmico", () => {
  it("pede a RPC nova com o recorte, e nenhuma das antigas do bloco quantitativo", async () => {
    await montar({ ano: "2026", semestre: "1" });
    expect(rpcMock).toHaveBeenCalledWith("carteira_em_aberto_por_status_academico",
      { p_ano: "2026", p_semestre: "1" });
    const nomes = rpcMock.mock.calls.map((c) => c[0]);
    // a função cara que estourava os 8s não pode ser alcançada pela tela
    expect(nomes).not.toContain("carteira_academico_universo");
    expect(nomes).not.toContain("carteira_academico_perfil");
  });

  it("responde a pergunta da diretoria: alunos, títulos e saldo por status", async () => {
    await montar();
    const linha = screen.getByText("Formado").closest("tr");
    expect(txt(linha)).toContain("152");
    expect(txt(linha)).toContain("570");
    expect(txt(linha)).toContain("R$ 380.060,92");
    expect(txt(linha)).toContain("10,34%");
  });

  it("não agrupa categorias diferentes nem inventa equivalência", async () => {
    await montar();
    expect(screen.getByText("Aguardando Matrícula")).toBeTruthy();
    expect(screen.getByText("Matriculado Curso Normal")).toBeTruthy();
    expect(screen.queryByText("Outros")).toBeNull();
  });

  it("fecha com o total: a tabela mostra o total em aberto e 100%", async () => {
    await montar();
    const rodape = screen.getByText("Total em aberto").closest("tr");
    expect(txt(rodape)).toContain("1.976");
    expect(txt(rodape)).toContain("6.367");
    expect(txt(rodape)).toContain("R$ 3.675.095,03");
    expect(txt(rodape)).toContain("100,00%");
  });

  it("mantém visível o buraco de cobertura de 2024, com o percentual", async () => {
    await montar();
    expect(screen.getByText("(sem situação importada)")).toBeTruthy();
    expect(screen.getByText(/53,46% do saldo de 2024 está sem situação acadêmica importada/)).toBeTruthy();
  });

  it("diz que o status é fotografia da importação, com a data — não consulta de hoje", async () => {
    await montar();
    expect(screen.getByText(/relatório acadêmico importado em 04\/08\/2026/)).toBeTruthy();
    expect(screen.getByText(/não consulta de hoje/)).toBeTruthy();
  });

  it("publica a conferência da composição mesmo quando ela fecha", async () => {
    await montar();
    expect(screen.getByText(/Conferência da composição/)).toBeTruthy();
    expect(screen.getByText(/diferença de R\$ 0,00/)).toBeTruthy();
  });

  it("quando a composição NÃO fecha, avisa e não ajusta nada", async () => {
    responder({ ...C_2024, conferencia: { ...C_2024.conferencia, diferenca: 9.9, fecha: false } });
    await montar();
    expect(screen.getByText(/difere do saldo em aberto em R\$ 9,90/)).toBeTruthy();
    expect(screen.getByText("R$ 3.675.095,03")).toBeTruthy();
  });

  it("em 2026/1 declara que o universo em aberto inclui a validação", async () => {
    responder(C_2026_1);
    await montar({ ano: "2026", semestre: "1" });
    expect(screen.getByText(/universo em aberto inclui o que está em validação/)).toBeTruthy();
  });

  it("erro da RPC aparece na tela e diz que o resto segue válido", async () => {
    responder(null, { message: "Acesso negado." });
    await montar();
    expect(screen.getByText(/Não foi possível compor o saldo por status acadêmico: Acesso negado/)).toBeTruthy();
    expect(screen.getByText(/seguem válidos/)).toBeTruthy();
  });

  it("recarga refaz a consulta — é o que o botão Atualizar dados aciona", async () => {
    await montar();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    cleanup();
    await montar({ ano: "2024", semestre: null, recarga: 1 });
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });
});

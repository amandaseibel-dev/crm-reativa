// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import SeisLinhasDaSafra from "./SeisLinhasDaSafra";

// Os números abaixo são os MEDIDOS em produção em 05/10/2026, não inventados:
// 2024 fecha em R$ 5.159.080,84 e o Pendente dele é R$ 14.401,19 em confirmação
// mais R$ 25.285,00 de "PAGO sem lastro".
const SAFRA_2024 = {
  recorte: "2024",
  natureza: "COBERTURA_HISTORICA",
  fonte: "acordos_titulos + serie da Prime, ao vivo",
  gerado_em: "2026-10-05T20:45:00Z",
  situacoes: {
    entrou:    { alunos: 2528, titulos: 8469, valor: 5159080.84 },
    pago:      { alunos: 24, titulos: 77, valor: 31369.29 },
    negociado: { alunos: 16, titulos: 58, valor: 34840.53 },
    cancelado: { alunos: 1, titulos: 5, valor: 57550.10 },
    em_aberto: { alunos: 2482, titulos: 8323, valor: 4995634.73 },
    pendente:  { alunos: 19, titulos: 52, valor: 39686.19 },
  },
  conferencia: { entrou: 5159080.84, soma_das_linhas: 5159080.84, diferenca: 0, fecha: true },
  pendente_detalhe: { pago_sem_lastro: 25285.00, em_confirmacao: 14401.19 },
};

const SAFRA_2026_1 = {
  recorte: "2026/1",
  natureza: "CARTEIRA_CONSOLIDADA",
  fonte: "carteira_2026_1_classificar() ao vivo",
  gerado_em: "2026-10-05T20:45:00Z",
  situacoes: {
    entrou:    { alunos: 5247, titulos: 14979, valor: 21710447.29 },
    pago:      { alunos: 1826, titulos: 5068, valor: 6005263.81 },
    negociado: { alunos: 944, titulos: 2961, valor: 4662443.01 },
    cancelado: { alunos: 3, titulos: 15, valor: 112595.16 },
    em_aberto: { alunos: 2103, titulos: 6779, valor: 9136169.08 },
    pendente:  { alunos: 1159, titulos: 2414, valor: 1793976.23 },
  },
  conferencia: { entrou: 21710447.29, soma_das_linhas: 21710447.29, diferenca: 0, fecha: true },
  pendente_detalhe: {
    convertido_origem_comprovada: 946711.07, em_validacao: 807802.95,
    ajuste_academico: 39462.21, pago_sem_lastro: 0,
  },
};

const PERFIL_2024 = {
  recorte: "2024",
  total_alunos: 1976,
  // `grupos` é a consulta viva ao Prime e está praticamente vazia — a tela NÃO
  // deve usá-la. Vem no mock de propósito, para o teste provar isso.
  grupos: [{ grupo: "Ainda não consultados", alunos: 1950, pct: 98.7 }],
  importacao: {
    fonte: "Relatório de inadimplência (importação)",
    atualizado_em: "2026-08-04T15:19:51Z",
    situacoes: [
      { situacao: "(sem situação importada)", alunos: 806 },
      { situacao: "Término do Contrato", alunos: 382 },
      { situacao: "Desvinculado", alunos: 245 },
      { situacao: "Formado", alunos: 152 },
      { situacao: "Cancelado", alunos: 151 },
      { situacao: "Trancado", alunos: 139 },
      { situacao: "Trancamento Institucional", alunos: 86 },
      { situacao: "Reopção de Curso", alunos: 5 },
      { situacao: "Matriculado Curso Normal", alunos: 3 },
      { situacao: "Saída por Transferência", alunos: 2 },
      { situacao: "Entrada via Reabertura", alunos: 1 },
      { situacao: "Falecido", alunos: 1 },
      { situacao: "Cancelamento Institucional", alunos: 1 },
      { situacao: "Mudança de Campus", alunos: 1 },
      { situacao: "Aguardando Matrícula", alunos: 1 },
    ],
  },
};

function responder(safra, perfil) {
  rpcMock.mockImplementation((nome) => {
    if (nome === "carteira_safra_situacoes") return Promise.resolve({ data: safra, error: null });
    if (nome === "carteira_academico_perfil") return Promise.resolve({ data: perfil, error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

async function montar(props = { ano: "2024", semestre: null }) {
  await act(async () => { render(<SeisLinhasDaSafra {...props} />); });
}

beforeEach(() => { rpcMock.mockReset(); responder(SAFRA_2024, PERFIL_2024); });
afterEach(() => cleanup());

describe("As seis linhas da safra", () => {
  it("pede a RPC da safra com ano e semestre, e o perfil acadêmico do mesmo recorte", async () => {
    await montar({ ano: "2026", semestre: "1" });
    expect(rpcMock).toHaveBeenCalledWith("carteira_safra_situacoes", { p_ano: "2026", p_semestre: "1" });
    expect(rpcMock).toHaveBeenCalledWith("carteira_academico_perfil", { p_ano: "2026", p_semestre: "1" });
  });

  it("desenha as seis linhas na ordem da gestão", async () => {
    await montar();
    // "Cancelado" é rótulo de linha E categoria de status acadêmico na mesma
    // tela, então aqui a conferência é por quantidade mínima, não por unicidade.
    for (const r of ["Entrou", "Pago", "Negociado", "Em aberto", "Pendente de classificação"]) {
      expect(screen.getByText(r)).toBeTruthy();
    }
    expect(screen.getAllByText("Cancelado").length).toBeGreaterThanOrEqual(1);
  });

  it("mostra os valores medidos de 2024 sem recompor nada", async () => {
    await montar();
    expect(screen.getByText("R$ 5.159.080,84")).toBeTruthy();
    expect(screen.getByText("R$ 31.369,29")).toBeTruthy();
    expect(screen.getByText("R$ 4.995.634,73")).toBeTruthy();
  });

  it("lista alunos por status pelas categorias REAIS da base, não pela consulta viva", async () => {
    await montar();
    expect(screen.getByText("Alunos por status")).toBeTruthy();
    expect(screen.getByText("Formado")).toBeTruthy();
    expect(screen.getByText("Trancado")).toBeTruthy();
    expect(screen.getByText("Desvinculado")).toBeTruthy();
    // `grupos` (a consulta viva) NÃO alimenta a lista
    expect(screen.queryByText("Ainda não consultados")).toBeNull();
  });

  it("não inventa a categoria Evadido, e diz que ela não existe", async () => {
    await montar();
    expect(screen.queryByText("Evadido")).toBeNull();
    expect(screen.getByText(/não há .Evadido. entre elas/)).toBeTruthy();
  });

  it("datando a importação, não finge que o status é de hoje", async () => {
    await montar();
    expect(screen.getByText(/importado em 04\/08\/2026/)).toBeTruthy();
  });

  it("abre o Pendente de 2024 e nomeia o PAGO sem lastro em vez de somá-lo em Pago", async () => {
    await montar();
    expect(screen.getByText(/marcado como PAGO sem lastro nenhum/)).toBeTruthy();
    expect(screen.getByText(/R\$ 25\.285,00/)).toBeTruthy();
    expect(screen.getByText(/R\$ 14\.401,19/)).toBeTruthy();
  });

  it("em 2024/2025 avisa que Entrou é saldo residual, não a carteira original", async () => {
    await montar();
    expect(screen.getByText(/não é a carteira original/)).toBeTruthy();
    expect(screen.getByText(/saldo residual/)).toBeTruthy();
  });

  it("em 2026/1 abre a conversão de origem comprovada e avisa que é ao vivo", async () => {
    responder(SAFRA_2026_1, { ...PERFIL_2024, importacao: { ...PERFIL_2024.importacao, situacoes: [] } });
    await montar({ ano: "2026", semestre: "1" });
    expect(screen.getByText(/conversão com origem comprovada/)).toBeTruthy();
    expect(screen.getByText(/R\$ 946\.711,07/)).toBeTruthy();
    expect(screen.getByText(/não vem do snapshot de 11\/09\/2026/)).toBeTruthy();
    expect(screen.queryByText(/carteira original/)).toBeNull();
  });

  it("mostra a conferência da invariante com a diferença, mesmo quando fecha", async () => {
    await montar();
    expect(screen.getByText(/Conferência da invariante/)).toBeTruthy();
    expect(screen.getByText(/diferença de R\$ 0,00/)).toBeTruthy();
  });

  it("quando a invariante NÃO fecha, avisa e não ajusta número nenhum", async () => {
    responder({
      ...SAFRA_2024,
      conferencia: { entrou: 5159080.84, soma_das_linhas: 5159068.50, diferenca: 12.34, fecha: false },
    }, PERFIL_2024);
    await montar();
    expect(screen.getByText(/difere de Entrou em R\$ 12,34/)).toBeTruthy();
    // o Entrou segue exibido como veio, sem correção
    expect(screen.getByText("R$ 5.159.080,84")).toBeTruthy();
  });

  it("avisa que contagem de aluno não soma entre linhas", async () => {
    await montar();
    expect(screen.getByText(/não devem ser somadas/)).toBeTruthy();
  });

  it("erro da RPC aparece na tela em vez de cartão vazio", async () => {
    rpcMock.mockImplementation((nome) =>
      nome === "carteira_safra_situacoes"
        ? Promise.resolve({ data: null, error: { message: "Acesso negado." } })
        : Promise.resolve({ data: null, error: null }));
    await montar();
    expect(screen.getByText(/Não foi possível carregar as seis linhas: Acesso negado./)).toBeTruthy();
  });

  it("singular quando é um só", async () => {
    responder({
      ...SAFRA_2024,
      situacoes: { ...SAFRA_2024.situacoes, cancelado: { alunos: 1, titulos: 1, valor: 10 } },
    }, PERFIL_2024);
    await montar();
    expect(screen.queryByText(/\b1 alunos\b/)).toBeNull();
    expect(screen.queryByText(/\b1 títulos\b/)).toBeNull();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, within } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import StatusAcademicoPorSafra from "./StatusAcademicoPorSafra";

// Números INVENTADOS. Rótulo não é dado de aluno e fica o da base — é ele que o
// card tem de casar entre safras. Contagem real de aluno não entra em arquivo
// versionado.
//
// Os valores são escolhidos para exercitar o card: categoria que só existe numa
// safra, categoria com fatia minúscula, e totais fáceis de conferir de cabeça.
const P2024 = { importacao: { situacoes: [
  { situacao: "(sem situação importada)", alunos: 400 },
  { situacao: "Término do Contrato", alunos: 300 },
  { situacao: "Desvinculado", alunos: 200 },
  { situacao: "Entrada via Reabertura", alunos: 100 },
]}, snapshot: { gerado_em: "2026-10-06T20:33:46Z" } };

const P2025 = { importacao: { situacoes: [
  { situacao: "Término do Contrato", alunos: 600 },
  { situacao: "Cancelado", alunos: 300 },
  { situacao: "Desvinculado", alunos: 98 },
  { situacao: "TRANSFERENCIA DE CURRICULOS", alunos: 2 },
]}, snapshot: { gerado_em: "2026-10-06T20:33:46Z" } };

const P2026 = { importacao: { situacoes: [
  { situacao: "Aguardando Matrícula", alunos: 500 },
  { situacao: "Cancelado", alunos: 300 },
  { situacao: "Término do Contrato", alunos: 200 },
]}, snapshot: { gerado_em: "2026-10-06T20:33:46Z" } };

function responder(p24 = P2024, p25 = P2025, p26 = P2026) {
  rpcMock.mockImplementation((nome, args) => {
    if (nome !== "carteira_academico_perfil_ler") return Promise.resolve({ data: null, error: null });
    if (args.p_ano === "2024") return Promise.resolve({ data: p24, error: null });
    if (args.p_ano === "2025") return Promise.resolve({ data: p25, error: null });
    return Promise.resolve({ data: p26, error: null });
  });
}
const montar = async () => { await act(async () => { render(<StatusAcademicoPorSafra />); }); };

beforeEach(() => { rpcMock.mockReset(); responder(); });
afterEach(cleanup);

function linha(status) {
  return screen.getByText(status).closest("tr");
}

describe("Status acadêmico por safra", () => {
  it("lê os três snapshots e nunca a função que reconstrói o universo", async () => {
    await montar();
    const nomes = rpcMock.mock.calls.map((c) => c[0]);
    expect(nomes.filter((n) => n === "carteira_academico_perfil_ler")).toHaveLength(3);
    expect(nomes).not.toContain("carteira_academico_perfil");
    expect(nomes).not.toContain("carteira_academico_universo");
  });

  it("tem uma coluna por safra e as três no cabeçalho", async () => {
    await montar();
    for (const r of ["2024", "2025", "2026/1"]) {
      expect(screen.getByRole("columnheader", { name: r })).toBeTruthy();
    }
  });

  it("casa categoria por rótulo exato, em todas as safras em que ela existe", async () => {
    await montar();
    // "Término do Contrato" existe nas três
    const l = within(linha("Término do Contrato"));
    expect(l.getByText("300")).toBeTruthy();    // 2024
    expect(l.getByText("600")).toBeTruthy();    // 2025
    expect(l.getByText("200")).toBeTruthy();    // 2026/1
  });

  it("categoria ausente numa safra vira travessão, e não some nem vira outra", async () => {
    await montar();
    // "Entrada via Reabertura" só existe em 2024: 1 aluno, e "—" nas outras duas
    const l = within(linha("Entrada via Reabertura"));
    expect(l.getByText("100")).toBeTruthy();
    expect(l.getAllByText("—").length).toBeGreaterThanOrEqual(4); // 2 colunas x (alunos + %)
    // e a categoria exclusiva de 2025 continua existindo como linha propria
    expect(screen.getByText("TRANSFERENCIA DE CURRICULOS")).toBeTruthy();
  });

  it("o percentual é sobre o total DAQUELA safra", async () => {
    await montar();
    // 2024: 400 de 1.000
    expect(within(linha("(sem situação importada)")).getByText("40,0%")).toBeTruthy();  // 400 de 1.000
    // 2025: 600 de 1.000
    expect(within(linha("Término do Contrato")).getByText("60,0%")).toBeTruthy();
  });

  it("tem linha final de Total, uma por safra, somando as categorias daquela safra", async () => {
    await montar();
    const total = within(screen.getByText("Total de alunos").closest("tr"));
    expect(total.getAllByText("1.000")).toHaveLength(3);   // as tres safras somam 1.000 na fixture
    expect(total.getAllByText("100%")).toHaveLength(3);
  });

  it("categoria com aluno de verdade nunca aparece como 0%", async () => {
    await montar();
    // 2 de 1.000 em 2025 = 0,2%, nao 0%
    expect(within(linha("TRANSFERENCIA DE CURRICULOS")).getByText("0,2%")).toBeTruthy();
    // e um caso abaixo de 0,05% vira "<0,1%", nunca "0%"
    responder(P2024, { importacao: { situacoes: [
      { situacao: "Término do Contrato", alunos: 5000 }, { situacao: "Falecido", alunos: 1 }] } }, P2026);
    cleanup();
    await montar();
    expect(within(linha("Falecido")).getByText("<0,1%")).toBeTruthy();
  });

  it("não inventa agrupamento: cada rótulo da base é uma linha", async () => {
    await montar();
    expect(screen.queryByText("Outros")).toBeNull();
    expect(screen.queryByText(/Evadido/)).toBeNull();
    // "(sem situação importada)" é categoria da base e aparece com o rótulo dela
    expect(screen.getByText("(sem situação importada)")).toBeTruthy();
  });

  it("safra sem fotografia aparece como travessão e é avisada", async () => {
    responder(P2024, { sem_snapshot: true, recorte: "2025" }, P2026);
    await montar();
    expect(screen.getByText(/Sem fotografia ainda: 2025/)).toBeTruthy();
    const total = within(screen.getByText("Total de alunos").closest("tr"));
    expect(total.getAllByText("100%")).toHaveLength(2);
  });

  it("erro da RPC aparece, não vira tabela vazia", async () => {
    rpcMock.mockImplementation(() => Promise.resolve({ error: { message: "Acesso negado." } }));
    await montar();
    expect(screen.getByText(/Acesso negado/)).toBeTruthy();
  });
});

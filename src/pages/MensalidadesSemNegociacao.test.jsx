// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: { rpc: (...a) => rpcMock(...a) },
}));

const pdfSalvos = vi.hoisted(() => []);
vi.mock("jspdf", () => {
  class FakeJsPDF {
    constructor() {
      return new Proxy(this, {
        get(alvo, prop) {
          if (prop === "save") return (nome) => pdfSalvos.push(nome);
          if (prop === "getNumberOfPages") return () => 1;
          if (prop === "splitTextToSize") return (t) => [String(t)];
          return () => undefined;
        },
      });
    }
  }
  return { default: FakeJsPDF };
});

const efetividadeClicks = vi.hoisted(() => ({ n: 0 }));
vi.mock("./CarteiraEfetividade", () => ({
  default: ({ safraFixa }) => (
    <div data-testid="efetividade" data-safra={safraFixa}>
      <button type="button" onClick={() => { efetividadeClicks.n += 1; }}>Exportar PDF</button>
    </div>
  ),
}));

import MensalidadesSemNegociacao from "./MensalidadesSemNegociacao";

const base = {
  cpfs_semestre: 10,
  mensalidades_total: 20,
  saldo_total: 1000,
  meses: [],
  por_curso: [],
  por_unidade: [],
  por_faixa: [],
  destaques: {},
  evolucao_diaria: [],
  atualizado_em: "2026-11-13T10:00:00Z",
};

const dados2026_1 = { ...base, alunos_unicos_semestre: 9 };
const dados2026_2 = {
  ...base,
  alunos_unicos_semestre: 4147,
  cpf_diagnostico: {
    cpfs_validos: 4131,
    cpfs_compartilhados: 15,
    alunos_sem_cpf: 1,
    alunos_cpf_invalido: 1,
    alunos_com_cpf_divergente: 1,
    titulos_sem_cpf_ou_invalido: 78,
  },
};

function respostaPorRpc(nome) {
  if (nome === "relatorio_mensalidades_2026_1_sem_negociacao") return { data: dados2026_1, error: null };
  if (nome === "relatorio_mensalidades_2026_2_sem_negociacao") return { data: dados2026_2, error: null };
  return { data: { ok: true }, error: null };
}

const botao = (nome) => screen.getByRole("button", { name: nome });

async function trocarSemestre(semestre) {
  fireEvent.click(botao(new RegExp(`^${semestre}`)));
}

describe("MensalidadesSemNegociacao", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockImplementation((nome) => Promise.resolve(respostaPorRpc(nome)));
    pdfSalvos.length = 0;
    efetividadeClicks.n = 0;
  });

  it("abre em 2026/1 com a RPC de 2026/1 e sem o bloco de diagnóstico de CPF", async () => {
    render(<MensalidadesSemNegociacao />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("relatorio_mensalidades_2026_1_sem_negociacao"));
    expect(botao(/^2026\/1/).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("CPFs válidos distintos")).toBeNull();
    expect(screen.queryByRole("group", { name: /Tipo de relatório 2026\/2/ })).toBeNull();
    expect(screen.getByText(/Pode incluir mensalidades ou matrículas antecipadas referentes a 2026\/2/)).toBeTruthy();
  });

  it("em 2026/2 mostra o relatório de mensalidades com a RPC de 2026/2 e o diagnóstico de CPF", async () => {
    render(<MensalidadesSemNegociacao />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("relatorio_mensalidades_2026_1_sem_negociacao"));
    await trocarSemestre("2026/2");
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("relatorio_mensalidades_2026_2_sem_negociacao"));
    expect(await screen.findByText("CPFs válidos distintos")).toBeTruthy();
    expect(screen.getByText("4.131")).toBeTruthy();
    expect(screen.getByText("Alunos sem CPF")).toBeTruthy();
    expect(screen.getByText(/julho e dezembro de 2026 ainda sem negociação/)).toBeTruthy();
  });

  it("Exportar PDF em 2026/1 salva o relatório de 2026/1", async () => {
    render(<MensalidadesSemNegociacao />);
    await waitFor(() => expect(botao(/Exportar PDF/)).toBeTruthy());
    fireEvent.click(botao(/Exportar PDF/));
    await waitFor(() => expect(pdfSalvos).toHaveLength(1));
    expect(pdfSalvos[0]).toMatch(/^relatorio-2026-1-sem-negociacao_/);
    expect(efetividadeClicks.n).toBe(0);
  });

  it("Exportar PDF em 2026/2 (mensalidades) salva o relatório de 2026/2, não o de efetividade", async () => {
    render(<MensalidadesSemNegociacao />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("relatorio_mensalidades_2026_1_sem_negociacao"));
    await trocarSemestre("2026/2");
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("relatorio_mensalidades_2026_2_sem_negociacao"));
    await waitFor(() => expect(botao(/Exportar PDF/)).toBeTruthy());
    fireEvent.click(botao(/Exportar PDF/));
    await waitFor(() => expect(pdfSalvos).toHaveLength(1));
    expect(pdfSalvos[0]).toMatch(/^relatorio-2026-2-sem-negociacao_/);
    expect(efetividadeClicks.n).toBe(0);
  });

  it("em 2026/2 a opção Efetividade mantém o componente da #921 com safra 2026/2 e seu próprio PDF", async () => {
    render(<MensalidadesSemNegociacao />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("relatorio_mensalidades_2026_1_sem_negociacao"));
    await trocarSemestre("2026/2");
    fireEvent.click(botao(/Efetividade 2026\/2/));
    expect(screen.getByTestId("efetividade").getAttribute("data-safra")).toBe("2026/2");
    fireEvent.click(botao(/Exportar PDF/));
    expect(efetividadeClicks.n).toBe(1);
    expect(pdfSalvos).toHaveLength(0);
  });

  it("trocar de semestre volta à vista de mensalidades e não mistura os relatórios", async () => {
    render(<MensalidadesSemNegociacao />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("relatorio_mensalidades_2026_1_sem_negociacao"));
    await trocarSemestre("2026/2");
    fireEvent.click(botao(/Efetividade 2026\/2/));
    expect(screen.getByTestId("efetividade")).toBeTruthy();
    await trocarSemestre("2026/1");
    await waitFor(() => expect(screen.queryByTestId("efetividade")).toBeNull());
    expect(screen.queryByText("CPFs válidos distintos")).toBeNull();
    expect(screen.getByText(/Pode incluir mensalidades ou matrículas antecipadas referentes a 2026\/2/)).toBeTruthy();
  });

  it("Atualizar usa a captura do semestre selecionado", async () => {
    render(<MensalidadesSemNegociacao />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("relatorio_mensalidades_2026_1_sem_negociacao"));
    fireEvent.click(botao(/Atualizar/));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("relatorio_mensalidades_2026_1_capturar"));
    await trocarSemestre("2026/2");
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("relatorio_mensalidades_2026_2_sem_negociacao"));
    fireEvent.click(botao(/Atualizar/));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("relatorio_mensalidades_2026_2_capturar"));
  });
});

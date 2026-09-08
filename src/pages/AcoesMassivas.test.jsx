// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// Dublês leves: só a RPC. O que se prova aqui é que o filtro de status
// acadêmico aceita VÁRIOS status marcados e manda todos ao banco, separados
// por "|" -- e que, sem nada marcado, o filtro não vai (null).
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
vi.mock("xlsx", () => ({ utils: {}, writeFile: () => {} }));

import AcoesMassivas from "./AcoesMassivas";

function chamadaPrevia() {
  const c = rpcMock.mock.calls.filter(([nome]) => nome === "acoes_massivas_previa").at(-1);
  return c ? c[1] : null;
}

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (nome) => {
    if (nome === "acoes_massivas_filtros") {
      return { data: { unidades: [], cursos: [], situacoes_academicas: ["Matriculado", "Aguardando matrícula", "Trancado"] } };
    }
    if (nome === "acoes_massivas_borderos") return { data: [] };
    if (nome === "acoes_massivas_previa") return { data: { elegiveis: [], excluidos_confirmacao: [] } };
    return { data: null };
  });
});
afterEach(cleanup);

async function montar() {
  await act(async () => { render(<AcoesMassivas />); });
  // As opções chegam por RPC; esperar a caixa de status aparecer.
  await screen.findByLabelText("Matriculado");
}

async function buscar() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Buscar/ })); });
}

describe("Ações Massivas — filtro de status acadêmico", () => {
  it("sem nada marcado, não manda filtro de status", async () => {
    await montar();
    await buscar();
    expect(chamadaPrevia()).toBeTruthy();
    expect(chamadaPrevia().p_situacao_academica).toBeNull();
  });

  it("dois status marcados vão juntos ao banco, separados por |", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Matriculado"));
    fireEvent.click(screen.getByLabelText("Trancado"));
    expect(screen.getByText(/Status acadêmico · 2 selec\./)).toBeTruthy();
    await buscar();
    expect(chamadaPrevia().p_situacao_academica).toBe("Matriculado|Trancado");
  });

  it("desmarcar um status tira ele da chamada; 'limpar status' zera tudo", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Matriculado"));
    fireEvent.click(screen.getByLabelText("Trancado"));
    fireEvent.click(screen.getByLabelText("Matriculado"));
    await buscar();
    expect(chamadaPrevia().p_situacao_academica).toBe("Trancado");
    fireEvent.click(screen.getByRole("button", { name: "limpar status" }));
    await buscar();
    expect(chamadaPrevia().p_situacao_academica).toBeNull();
  });
});

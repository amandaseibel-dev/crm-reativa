// @vitest-environment jsdom
// C2 -- mural de ideias. A garantia de que campo interno não sai do banco está em
// supabase/tests/portal_ideias_equipe.test.js; aqui se verifica a tela.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
const fromMock = vi.fn();
vi.mock("../../services/supabase", () => ({
  supabase: { rpc: (...a) => rpcMock(...a), from: (...a) => fromMock(...a) },
}));

import IdeiasEquipe from "./IdeiasEquipe";
import { SEM_IDEIAS, ORDENS, ROTULO_STATUS, rotuloStatus } from "./ideias";

afterEach(cleanup);

const EU = "cobranca05@aelbra.com.br";
const S = {};
const Card = ({ children }) => <div>{children}</div>;
const CabecalhoCard = ({ titulo, acao }) => <div><strong>{titulo}</strong>{acao}</div>;

const ideia = (id, descricao, extra = {}) => ({
  id, descricao, autor: "Luana", criado_em: "2026-09-25T12:00:00Z",
  status: "NOVA", curtidas: 0, eu_curti: false, ...extra,
});

// insert/delete devolvem {error}; delete tem a cadeia .eq().eq().ilike()
function montarEscrita({ error = null } = {}) {
  const insert = vi.fn(() => Promise.resolve({ error }));
  const ilike = vi.fn(() => Promise.resolve({ error }));
  const eq2 = vi.fn(() => ({ ilike }));
  const eq1 = vi.fn(() => ({ eq: eq2 }));
  const del = vi.fn(() => ({ eq: eq1 }));
  fromMock.mockImplementation(() => ({ insert, delete: del }));
  return { insert, del, ilike };
}

const desenhar = () =>
  act(async () => {
    render(<IdeiasEquipe usuario={{ email: EU }} Card={Card} CabecalhoCard={CabecalhoCard} S={S} />);
  });

describe("rótulo de status", () => {
  it("traduz os status reais do fluxo", () => {
    expect(rotuloStatus("NOVA")).toBe("Nova");
    expect(rotuloStatus("REABERTO")).toBe("Reaberta");
    expect(rotuloStatus("FEITA")).toBe("Implementada");
    expect(rotuloStatus("DESCARTADA")).toBe("Não seguirá");
    expect(Object.keys(ROTULO_STATUS).sort()).toEqual(["DESCARTADA", "FEITA", "NOVA", "REABERTO"]);
  });

  it("status desconhecido não quebra: aparece capitalizado", () => {
    expect(rotuloStatus("EM_ANALISE")).toBe("Em_analise");
    expect(rotuloStatus("")).toBe("Sem status");
    expect(rotuloStatus(null)).toBe("Sem status");
  });

  it("só duas ordenações, como pedido", () => {
    expect(ORDENS.map((o) => o.valor)).toEqual(["curtidas", "recentes"]);
  });
});

describe("mural de ideias", () => {
  beforeEach(() => { rpcMock.mockReset(); fromMock.mockReset(); });

  it("mostra ideia, autor, data, status e curtidas", async () => {
    rpcMock.mockResolvedValue({
      data: [ideia("i1", "Colocar filtro por unidade na carteira", { status: "FEITA", curtidas: 4 })],
      error: null,
    });
    await desenhar();

    expect(screen.getByText("Ideias da equipe")).toBeTruthy();
    expect(screen.getByText("Colocar filtro por unidade na carteira")).toBeTruthy();
    expect(screen.getByText("Luana")).toBeTruthy();
    expect(screen.getByText("25/09/2026")).toBeTruthy();
    expect(screen.getByText("Implementada")).toBeTruthy();
    expect(screen.getByRole("button", { name: /🤍 4/ })).toBeTruthy();
  });

  it("começa em 'Mais curtidas' e troca a ordenação recarregando do banco", async () => {
    rpcMock.mockResolvedValue({ data: [ideia("i1", "Uma ideia")], error: null });
    await desenhar();

    expect(rpcMock).toHaveBeenCalledWith("portal_ideias_equipe", { p_ordem: "curtidas", p_limite: 12 });

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Ordenar ideias"), { target: { value: "recentes" } });
    });
    expect(rpcMock).toHaveBeenCalledWith("portal_ideias_equipe", { p_ordem: "recentes", p_limite: 12 });
  });

  it("curtir insere e recarrega", async () => {
    rpcMock.mockResolvedValue({ data: [ideia("i1", "Uma ideia")], error: null });
    const { insert } = montarEscrita();
    await desenhar();
    const chamadasAntes = rpcMock.mock.calls.length;

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /🤍 0/ })); });

    expect(insert).toHaveBeenCalledWith({ alvo_tipo: "ideia", alvo_id: "i1", usuario_email: EU });
    expect(rpcMock.mock.calls.length).toBe(chamadasAntes + 1);
  });

  it("descurtir apaga a própria curtida", async () => {
    rpcMock.mockResolvedValue({
      data: [ideia("i1", "Uma ideia", { curtidas: 3, eu_curti: true })], error: null,
    });
    const { del, ilike } = montarEscrita();
    await desenhar();

    const b = screen.getByRole("button", { name: /❤️ 3/ });
    expect(b.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { fireEvent.click(b); });

    expect(del).toHaveBeenCalled();
    expect(ilike).toHaveBeenCalledWith("usuario_email", EU);
  });

  it("autor ausente vira 'Equipe' em vez de vazio", async () => {
    rpcMock.mockResolvedValue({ data: [ideia("i1", "Anônima", { autor: null })], error: null });
    await desenhar();
    expect(screen.getByText("Equipe")).toBeTruthy();
  });

  it("sem ideias visíveis, mostra o estado vazio", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    await desenhar();
    expect(screen.getByText(SEM_IDEIAS)).toBeTruthy();
  });

  it("some da Home quando a migration ainda não foi aplicada", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    const { container } = render(
      <IdeiasEquipe usuario={{ email: EU }} Card={Card} CabecalhoCard={CabecalhoCard} S={S} />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("erro inesperado cai no estado vazio", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcMock.mockResolvedValue({ data: null, error: { code: "57014" } });
    await desenhar();
    expect(screen.getByText(SEM_IDEIAS)).toBeTruthy();
    erro.mockRestore();
  });

  it("curtida recusada pelo banco vira mensagem amigável, sem SQL cru", async () => {
    const alerta = vi.spyOn(window, "alert").mockImplementation(() => {});
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcMock.mockResolvedValue({ data: [ideia("i1", "Uma ideia")], error: null });
    montarEscrita({ error: { code: "23505" } });
    await desenhar();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /🤍 0/ })); });

    expect(alerta).toHaveBeenCalledWith("Você já curtiu.");
    alerta.mockRestore(); erro.mockRestore();
  });
});

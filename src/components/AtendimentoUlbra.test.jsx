// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AtendimentoUlbra from "./AtendimentoUlbra";

vi.mock("../services/supabase", () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "tok123" } } }) },
  },
}));

vi.stubEnv("VITE_SUPABASE_URL", "http://localhost:54321");
const fetchMock = vi.fn();

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

const ENCONTRADO = {
  status: "encontrado",
  atendimento: { id: "a1", situacao: "accepted", coluna: "contacted", equipe: "Reativa", atendente: "Luana Marques", entrou_em: "2026-09-21T20:10:29.891Z", atualizado_em: "2026-11-04T11:00:50.253Z" },
};

describe("AtendimentoUlbra", () => {
  it("mostra situação, equipe, responsável e atualização", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ENCONTRADO });
    const { container } = render(<AtendimentoUlbra sobDemanda={false} aluno={{ id: "aluno-1" }} />);
    await waitFor(() => expect(screen.getByText(/Em atendimento/)).toBeTruthy());
    const texto = container.textContent;
    expect(texto).toContain("Equipe: Reativa");
    expect(texto).toContain("Responsável: Luana Marques");
    expect(texto).toContain("Atualizado em: 04/11/2026");
    expect(texto).toContain("contacted");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/ulbra-atendimento");
    expect(JSON.parse(opts.body)).toEqual({ aluno_id: "aluno-1" });
    expect(opts.headers.Authorization).toBe("Bearer tok123");
  });

  it("sem responsável e situação desconhecida não quebra", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: "encontrado", atendimento: { id: "a2", situacao: "zzz", equipe: null, atendente: null, atualizado_em: null } }) });
    const { container } = render(<AtendimentoUlbra sobDemanda={false} aluno={{ id: "aluno-2" }} />);
    await waitFor(() => expect(container.textContent).toContain("sem responsável"));
    expect(container.textContent).toContain("zzz");
    expect(container.textContent).toContain("Atualizado em: —");
  });

  it("sem_atendimento mostra aviso discreto", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: "sem_atendimento", atendimento: null }) });
    render(<AtendimentoUlbra sobDemanda={false} aluno={{ id: "aluno-3" }} />);
    await waitFor(() => expect(screen.getByText(/Sem atendimento na Mensageria/)).toBeTruthy());
  });

  it("sem_vinculo, erro HTTP e falha de rede não renderizam nada", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: "sem_vinculo" }) });
    const a = render(<AtendimentoUlbra sobDemanda={false} aluno={{ id: "aluno-4" }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(a.container.firstChild).toBeNull();

    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ erro: "ULBRA_INDISPONIVEL" }) });
    const b = render(<AtendimentoUlbra sobDemanda={false} aluno={{ id: "aluno-5" }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(b.container.firstChild).toBeNull();

    fetchMock.mockRejectedValueOnce(new Error("rede"));
    const c = render(<AtendimentoUlbra sobDemanda={false} aluno={{ id: "aluno-6" }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(c.container.firstChild).toBeNull();
  });

  it("uma chamada por aluno; sem aluno não chama", () => {
    render(<AtendimentoUlbra sobDemanda={false} aluno={null} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

});

describe("AtendimentoUlbra sob demanda (padrão)", () => {
  it("não chama a função ao abrir; só depois do clique", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: "sem_atendimento" }) });
    render(<AtendimentoUlbra aluno={{ id: "al-1" }} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("ulbra-atendimento-consultar"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText(/Sem atendimento na Mensageria Ulbra/)).length).toBeGreaterThan(0);
  });
});

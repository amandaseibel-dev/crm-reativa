// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import UlbraDiagnostico from "./UlbraDiagnostico";

vi.mock("../services/supabase", () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "tok123" } } }) },
  },
}));

vi.stubEnv("VITE_SUPABASE_URL", "http://localhost:54321");

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
// O projeto não liga `globals`, então a limpeza entre testes é explícita:
// sem ela os renders se acumulam no mesmo DOM.
afterEach(cleanup);

const GESTAO = { perfil: { perfil: "gerencia" } };
const RESPOSTA = {
  acesso: {
    conexao_tipo: "servico",
    perfis: ["gestao"],
    escopos: ["clientes:read", "conversas:read"],
    limites: { pessoaPorDia: { limite: 500, restam: 462 } },
  },
  ferramentas: ["conferir_duplicidade", "ler_conversa"],
  total_ferramentas: 2,
};

describe("UlbraDiagnostico", () => {
  it("recusa quem não é gestão, sem chamar a função", () => {
    render(<UlbraDiagnostico usuario={{ perfil: { perfil: "operador" } }} />);
    expect(screen.getByText(/restrita à gestão/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("chama a função com o JWT da sessão e mostra escopos, limites e ferramentas", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => RESPOSTA });
    render(<UlbraDiagnostico usuario={GESTAO} />);
    fireEvent.click(screen.getByRole("button", { name: /executar diagnóstico/i }));

    await waitFor(() => expect(screen.getByText("conversas:read")).toBeTruthy());
    const [url, opcoes] = fetchMock.mock.calls[0];
    expect(url).toContain("/functions/v1/ulbra-diagnostico");
    expect(opcoes.headers.Authorization).toBe("Bearer tok123");
    expect(screen.getByText("pessoaPorDia")).toBeTruthy();
    expect(screen.getByText("ler_conversa")).toBeTruthy();
    expect(screen.getByText(/Ferramentas \(2\)/)).toBeTruthy();
  });

  it("mostra o motivo quando a função recusa", async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 403,
      json: async () => ({ erro: "ACESSO_NEGADO", detalhe: "somente_gestao" }),
    });
    render(<UlbraDiagnostico usuario={GESTAO} />);
    fireEvent.click(screen.getByRole("button", { name: /executar diagnóstico/i }));
    await waitFor(() => expect(screen.getByText(/ACESSO_NEGADO · somente_gestao/)).toBeTruthy());
  });

  it("avisa quando não há sessão, sem chamar a função", async () => {
    const { supabase } = await import("../services/supabase");
    supabase.auth.getSession.mockResolvedValueOnce({ data: { session: null } });
    render(<UlbraDiagnostico usuario={GESTAO} />);
    fireEvent.click(screen.getByRole("button", { name: /executar diagnóstico/i }));
    await waitFor(() => expect(screen.getByText(/Sessão não encontrada/i)).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

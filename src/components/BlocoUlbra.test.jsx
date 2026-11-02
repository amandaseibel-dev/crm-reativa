// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import BlocoUlbra from "./BlocoUlbra";

vi.mock("../services/supabase", () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "tok123" } } }) },
  },
}));

const VITE_URL = "http://localhost:54321";
vi.stubEnv("VITE_SUPABASE_URL", VITE_URL);

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn();
});

describe("BlocoUlbra", () => {
  it("renderiza link quando status é vinculado", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "vinculado",
        url: "https://crm.ulbra.ai/atendimentos/abc123",
      }),
    });

    render(<BlocoUlbra aluno={{ id: "aluno-1" }} />);
    await waitFor(() => {
      const link = screen.getByRole("link");
      expect(link).toBeTruthy();
      expect(link.getAttribute("href")).toBe("https://crm.ulbra.ai/atendimentos/abc123");
      expect(link.getAttribute("target")).toBe("_blank");
    });
  });

  it("exibe mensagem de múltiplos cadastros quando status é ambiguo", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "ambiguo" }),
    });

    render(<BlocoUlbra aluno={{ id: "aluno-2" }} />);
    await waitFor(() => {
      expect(screen.getByText(/Múltiplos cadastros/)).toBeTruthy();
    });
  });

  it("exibe motivo SEM_TELEFONE quando aluno não tem telefone", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "nao_encontrado", motivo: "SEM_TELEFONE" }),
    });

    render(<BlocoUlbra aluno={{ id: "aluno-3" }} />);
    await waitFor(() => {
      expect(screen.getByText(/sem telefone/i)).toBeTruthy();
    });
  });

  it("retorna null em caso de erro de rede", async () => {
    global.fetch.mockRejectedValueOnce(new Error("network error"));

    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-4" }} />);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("não chama fetch quando aluno_id é null", () => {
    render(<BlocoUlbra aluno={null} />);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("envia aluno_id e Authorization corretos na requisição", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "nao_encontrado", motivo: "NAO_ENCONTRADO" }),
    });

    render(<BlocoUlbra aluno={{ id: "aluno-xyz" }} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain("/ulbra-consultar");
    const body = JSON.parse(opts.body);
    expect(body.aluno_id).toBe("aluno-xyz");
    expect(opts.headers.Authorization).toBe("Bearer tok123");
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import BlocoUlbra from "./BlocoUlbra";

vi.mock("../services/supabase", () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "tok123" } } }) },
  },
}));

const VITE_URL = "http://localhost:54321";
vi.stubEnv("VITE_SUPABASE_URL", VITE_URL);

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BlocoUlbra", () => {
  it("renderiza link quando status é vinculado", async () => {
    fetchMock.mockResolvedValueOnce({
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
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "ambiguo" }),
    });

    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-2" }} />);
    await waitFor(() => {
      expect(screen.getByText(/Múltiplos cadastros/)).toBeTruthy();
    });
    // A rota /gestao/ulbra não existe: o estado ambíguo não pode apontar para ela
    expect(container.querySelector("a")).toBeNull();
  });

  it("exibe FORA_DO_ESCOPO sem link e sem dados do aluno", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "nao_encontrado", motivo: "FORA_DO_ESCOPO" }),
    });

    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-5" }} />);
    await waitFor(() => {
      expect(screen.getByText(/fora do escopo/i)).toBeTruthy();
    });
    expect(container.querySelector("a")).toBeNull();
  });

  it("não renderiza nada quando a função devolve erro (502 ULBRA_INDISPONIVEL)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ erro: "ULBRA_INDISPONIVEL" }),
    });

    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-6" }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("exibe motivo SEM_TELEFONE quando aluno não tem telefone", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "nao_encontrado", motivo: "SEM_TELEFONE" }),
    });

    render(<BlocoUlbra aluno={{ id: "aluno-3" }} />);
    await waitFor(() => {
      expect(screen.getByText(/sem telefone/i)).toBeTruthy();
    });
  });

  it("retorna null em caso de erro de rede", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-4" }} />);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("não chama fetch quando aluno_id é null", () => {
    render(<BlocoUlbra aluno={null} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("envia aluno_id e Authorization corretos na requisição", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "nao_encontrado", motivo: "NAO_ENCONTRADO" }),
    });

    render(<BlocoUlbra aluno={{ id: "aluno-xyz" }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/ulbra-consultar");
    const body = JSON.parse(opts.body);
    expect(body.aluno_id).toBe("aluno-xyz");
    expect(opts.headers.Authorization).toBe("Bearer tok123");
  });
});

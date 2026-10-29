// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Cobre três dimensões:
// 1. AUTORIZAÇÃO DA ROTA: usuários sem gestão são redirecionados antes de ver a tela.
// 2. INTERPRETAÇÃO DA RESPOSTA: sucesso com/sem portador 166, lista vazia.
// 3. TRATAMENTO DE ERROS: erro da função, status inesperado do Prime, formato desconhecido.

// ── Mock do supabase ──────────────────────────────────────────────────────────
const invokeMock = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: {
    functions: { invoke: (...a) => invokeMock(...a) },
  },
}));

import DiagnosticoPortador166 from "./DiagnosticoPortador166";

// ── Helpers ───────────────────────────────────────────────────────────────────

// RotaProtegida real do App.jsx é complexa; aqui usamos uma versão mínima
// que replica exatamente o guard do /diagnostico-portador-166.
const EMAILS_GESTAO = [
  "amanda.seibel@aelbra.com.br",
  "cobranca04@aelbra.com.br",
  "cobranca07@aelbra.com.br",
];

function RotaProtegidaMinima({ email, children }) {
  if (!EMAILS_GESTAO.includes(email)) {
    return <div data-testid="redirecionado">Sem acesso</div>;
  }
  return children;
}

function renderComGuard(email) {
  return render(
    <MemoryRouter initialEntries={["/diagnostico-portador-166"]}>
      <Routes>
        <Route
          path="/diagnostico-portador-166"
          element={
            <RotaProtegidaMinima email={email}>
              <DiagnosticoPortador166 />
            </RotaProtegidaMinima>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

// Resposta bem-formada da prime-sonda com cru como array
function respostaOk(linhas) {
  return { data: { status: 200, cru: linhas }, error: null };
}

afterEach(cleanup);
beforeEach(() => {
  invokeMock.mockReset();
});

// ── 1. AUTORIZAÇÃO DA ROTA ────────────────────────────────────────────────────

describe("autorização da rota", () => {
  it("redireciona operador (email sem gestão)", () => {
    renderComGuard("operador@reativa.local");
    expect(screen.getByTestId("redirecionado")).toBeTruthy();
    expect(screen.queryByText(/Executar diagnóstico/)).toBeNull();
  });

  it("redireciona perfil sem e-mail cadastrado", () => {
    renderComGuard("");
    expect(screen.getByTestId("redirecionado")).toBeTruthy();
  });

  it("permite amanda.seibel@aelbra.com.br", () => {
    invokeMock.mockResolvedValue(respostaOk([]));
    renderComGuard("amanda.seibel@aelbra.com.br");
    expect(screen.getByRole("button", { name: /Executar diagnóstico/i })).toBeTruthy();
  });

  it("permite cobranca04@aelbra.com.br", () => {
    invokeMock.mockResolvedValue(respostaOk([]));
    renderComGuard("cobranca04@aelbra.com.br");
    expect(screen.getByRole("button", { name: /Executar diagnóstico/i })).toBeTruthy();
  });

  it("permite cobranca07@aelbra.com.br", () => {
    invokeMock.mockResolvedValue(respostaOk([]));
    renderComGuard("cobranca07@aelbra.com.br");
    expect(screen.getByRole("button", { name: /Executar diagnóstico/i })).toBeTruthy();
  });
});

// ── 2. INTERPRETAÇÃO DA RESPOSTA ──────────────────────────────────────────────

describe("interpretação da resposta", () => {
  function renderAutorizado() {
    return render(
      <MemoryRouter>
        <DiagnosticoPortador166 />
      </MemoryRouter>
    );
  }

  async function clicar() {
    fireEvent.click(screen.getByRole("button", { name: /Executar diagnóstico/i }));
  }

  it("mostra ✓ SIM quando portador 166 está presente", async () => {
    invokeMock.mockResolvedValue(respostaOk([
      { carrier: { id: 195 } },
      { carrier: { id: 166 } },
      { carrier: { id: 166 } },
    ]));
    renderAutorizado();
    await clicar();
    await waitFor(() => expect(screen.getByText(/✓ SIM/)).toBeTruthy());
    expect(screen.getByText("3")).toBeTruthy(); // total
    expect(screen.getAllByText(/Portador 166/).length).toBeGreaterThan(0);
    expect(screen.getByText("2 registros")).toBeTruthy(); // contagem do 166
  });

  it("mostra ✗ NÃO quando portador 166 está ausente", async () => {
    invokeMock.mockResolvedValue(respostaOk([
      { carrier: { id: 195 } },
      { carrier: { id: 195 } },
    ]));
    renderAutorizado();
    await clicar();
    await waitFor(() => expect(screen.getByText(/✗ NÃO/)).toBeTruthy());
    // Sem portador 166: nenhuma linha "Portador 166" na tabela de contagem
    expect(screen.queryByText("Portador 166")).toBeNull();
  });

  it("lista vazia — endpoint respondeu, zero registros, 166 ausente", async () => {
    invokeMock.mockResolvedValue(respostaOk([]));
    renderAutorizado();
    await clicar();
    await waitFor(() => expect(screen.getByText(/✓ Endpoint respondeu/)).toBeTruthy());
    expect(screen.getByText(/✗ NÃO/)).toBeTruthy();
    expect(screen.getByText(/lista vazia/i)).toBeTruthy();
  });

  it("aceita formato {items:[...]} além de array direto", async () => {
    invokeMock.mockResolvedValue({
      data: { status: 200, cru: { items: [{ carrier: { id: 166 } }] } },
      error: null,
    });
    renderAutorizado();
    await clicar();
    await waitFor(() => expect(screen.getByText(/✓ SIM/)).toBeTruthy());
  });

  it("não exibe CPF, boleto nem dados financeiros individuais", async () => {
    invokeMock.mockResolvedValue(respostaOk([
      { carrier: { id: 166 }, boleto: "BOLETO_SECRETO", cpf: "123.456.789-09", grossAmount: 500 },
    ]));
    renderAutorizado();
    await clicar();
    await waitFor(() => expect(screen.getByText(/✓ SIM/)).toBeTruthy());
    expect(screen.queryByText(/BOLETO_SECRETO/)).toBeNull();
    expect(screen.queryByText(/123\.456/)).toBeNull();
    expect(screen.queryByText(/grossAmount|R\$\s*500/)).toBeNull();
  });
});

// ── 3. TRATAMENTO DE ERROS ────────────────────────────────────────────────────

describe("tratamento de erros", () => {
  function renderAutorizado() {
    return render(
      <MemoryRouter>
        <DiagnosticoPortador166 />
      </MemoryRouter>
    );
  }

  async function clicar() {
    fireEvent.click(screen.getByRole("button", { name: /Executar diagnóstico/i }));
  }

  it("erro de autenticação — invoke retorna error com ACESSO_NEGADO", async () => {
    invokeMock.mockResolvedValue({ data: null, error: { message: "ACESSO_NEGADO: restrito a gestao" } });
    renderAutorizado();
    await clicar();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/AUTENTICACAO NEGADA/i)).toBeTruthy();
  });

  it("erro de autenticação — invoke retorna error com 403", async () => {
    invokeMock.mockResolvedValue({ data: null, error: { message: "403 Forbidden" } });
    renderAutorizado();
    await clicar();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/AUTENTICACAO NEGADA/i)).toBeTruthy();
  });

  it("erro sem autenticação — invoke retorna error com 401", async () => {
    invokeMock.mockResolvedValue({ data: null, error: { message: "401 Unauthorized" } });
    renderAutorizado();
    await clicar();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/SEM AUTENTICACAO/i)).toBeTruthy();
  });

  it("indisponibilidade do Prime — status 500 no campo data.status", async () => {
    invokeMock.mockResolvedValue({ data: { status: 500, forma: null }, error: null });
    renderAutorizado();
    await clicar();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/INDISPONIBILIDADE PRIME/i)).toBeTruthy();
    expect(screen.getByText(/status 500/)).toBeTruthy();
  });

  it("autenticação negada na API Prime — status 403 no campo data.status", async () => {
    invokeMock.mockResolvedValue({ data: { status: 403, forma: null }, error: null });
    renderAutorizado();
    await clicar();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/AUTENTICACAO PRIME NEGADA/i)).toBeTruthy();
  });

  it("formato inesperado — cru é um objeto sem items nem array", async () => {
    invokeMock.mockResolvedValue({
      data: { status: 200, cru: { campoDesconhecido: 42 } },
      error: null,
    });
    renderAutorizado();
    await clicar();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/FORMATO INESPERADO/i)).toBeTruthy();
    expect(screen.getByText(/campoDesconhecido/)).toBeTruthy();
  });

  it("formato inesperado — cru é null", async () => {
    invokeMock.mockResolvedValue({ data: { status: 200, cru: null }, error: null });
    renderAutorizado();
    await clicar();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/FORMATO INESPERADO/i)).toBeTruthy();
  });

  it("erro genérico da Edge Function sem mensagem específica", async () => {
    invokeMock.mockResolvedValue({ data: null, error: { message: "Internal Server Error" } });
    renderAutorizado();
    await clicar();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/ERRO FUNCAO/i)).toBeTruthy();
  });
});

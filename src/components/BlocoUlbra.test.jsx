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
        url: "https://crm.ulbra.ai/app/clientes/abc123",
      }),
    });

    render(<BlocoUlbra aluno={{ id: "aluno-1" }} />);
    await waitFor(() => {
      const link = screen.getByRole("link");
      expect(link).toBeTruthy();
      expect(link.getAttribute("href")).toBe("https://crm.ulbra.ai/app/clientes/abc123");
      expect(link.getAttribute("target")).toBe("_blank");
    });
  });

  // O botao mudou de aparencia (rotulo curto, estilo secundario) quando foi
  // para o cartao de contatos. Estes dois travam o que NAO pode mudar com o
  // visual: continua sendo link de verdade, e a aba nova nao recebe acesso a
  // esta -- `noopener` tira o `window.opener`, `noreferrer` tira o Referer.
  it("o link traz rel=noopener noreferrer (aba nova sem acesso a esta)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "vinculado",
        url: "https://crm.ulbra.ai/app/clientes/abc123",
      }),
    });

    // `container`, nao `screen`: os render anteriores deste arquivo seguem
    // montados no documento, e `screen` acharia os links deles tambem.
    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-rel" }} />);
    await waitFor(() => {
      const rel = container.querySelector("a")?.getAttribute("rel") || "";
      expect(rel).toContain("noopener");
      expect(rel).toContain("noreferrer");
    });
  });

  it("o rotulo do botao e 'CRM ULBRA ↗'", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "vinculado",
        url: "https://crm.ulbra.ai/app/clientes/abc123",
      }),
    });

    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-rotulo" }} />);
    await waitFor(() =>
      expect(container.querySelector("a")?.textContent.trim()).toBe("CRM ULBRA ↗"),
    );
  });

  it("status desconhecido (ex.: 'ambiguo' da versão antiga) não renderiza link nenhum", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "ambiguo" }),
    });

    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-2" }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
    // A rota /gestao/ulbra não existe: nenhum estado pode apontar para ela
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

  // -------------------------------------------------------------------------
  // Vínculo barrado: o operador PRECISA ver a recusa. Cair em silêncio é o que
  // faz a ficha parecer "sem Mensageria" quando existe candidato não provado.
  // -------------------------------------------------------------------------
  it.each([
    ["AMBIGUO_CHAVES_DISCORDANTES", /apontam clientes diferentes/i],
    ["DUPLICADO_CLIENTE_DE_OUTRO_ALUNO", /já está vinculado a outro aluno/i],
    ["CONFIRMACAO_MANUAL_SO_TELEFONE", /sem confirmação por CPF/i],
    ["CONFIRMACAO_MANUAL_SEM_CPF", /sem CPF cadastrado/i],
  ])("exibe o motivo do bloqueio %s, sem link", async (motivo, textoEsperado) => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "bloqueado", motivo }),
    });

    // Consultas escopadas no `container`: este arquivo não tem cleanup
    // automático, então `screen` vê os renders dos testes anteriores também.
    const { container } = render(<BlocoUlbra aluno={{ id: `aluno-${motivo}` }} />);
    await waitFor(() => expect(container.textContent).toMatch(textoEsperado));
    // Barrado nunca oferece link: clicar seria abrir o cliente não confirmado.
    expect(container.querySelector("a")).toBeNull();
  });

  it("bloqueio com motivo desconhecido ainda avisa, sem link", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "bloqueado", motivo: "MOTIVO_NOVO_DO_FUTURO" }),
    });

    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-b9" }} />);
    await waitFor(() => expect(container.textContent).toMatch(/não confirmado/i));
    expect(container.querySelector("a")).toBeNull();
  });

  // Falha de gravação não pode cair no silêncio: é exatamente o que acontece
  // se a função for publicada ANTES da migration 20261104200000.
  it.each([
    ["VINCULO_NAO_GRAVADO", /não gravado/i],
    ["VINCULO_LEITURA_FALHOU", /não foi possível ler/i],
    ["DECISAO_INESPERADA", /não concluído/i],
  ])("mostra a falha de gravação %s em vez de ficar em branco", async (erro, texto) => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ erro }) });

    const { container } = render(<BlocoUlbra aluno={{ id: `aluno-${erro}` }} />);
    await waitFor(() => expect(container.textContent).toMatch(texto));
    expect(container.querySelector("a")).toBeNull();
  });

  it("Mensageria fora do ar segue silenciosa (não é acionável na ficha)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ erro: "ULBRA_INDISPONIVEL" }) });

    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-indisp" }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  // Vínculo sem CPF confirmado NÃO pode oferecer o botão. Aviso sozinho não
  // segura ninguém: o botão ao lado continua clicável, e um clique abre o
  // atendimento de um cliente que ninguém confirmou ser este aluno.
  it("vínculo não confirmado por CPF: avisa e NÃO dá o botão", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "vinculado_nao_confirmado",
        confianca: "alta",
        origem: "telefone",
        reconfirmar_recomendado: true,
      }),
    });

    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-legado" }} />);
    await waitFor(() => expect(container.textContent).toMatch(/sem confirmação por CPF/i));
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toMatch(/gestão precisa conferir/i);
  });

  it("mesmo se a função devolver url com reconfirmar_recomendado, a tela não dá o botão", async () => {
    // Cinto e suspensório: versão anterior da função publicada por engano.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "vinculado",
        url: "https://crm.ulbra.ai/app/clientes/abc123",
        confianca: "alta",
        origem: "telefone",
        reconfirmar_recomendado: true,
      }),
    });

    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-legado-2" }} />);
    await waitFor(() => expect(container.textContent).toMatch(/sem confirmação por CPF/i));
    expect(container.querySelector("a")).toBeNull();
    expect(container.innerHTML).not.toContain("crm.ulbra.ai");
  });

  it("vínculo confirmado por CPF não exibe aviso de reconferência", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: "vinculado",
        url: "https://crm.ulbra.ai/app/clientes/abc123",
        confianca: "alta_cpf",
        origem: "cpf",
        reconfirmar_recomendado: false,
      }),
    });

    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-provado" }} />);
    await waitFor(() => expect(container.querySelector("a")).toBeTruthy());
    expect(container.textContent).not.toMatch(/confira a identidade/i);
  });

  it("nenhum estado da tela expõe telefone ou CPF do aluno", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "bloqueado", motivo: "CONFIRMACAO_MANUAL_SO_TELEFONE" }),
    });

    const { container } = render(<BlocoUlbra aluno={{ id: "aluno-lgpd", telefone: "51999990000", cpf: "12345678901" }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toMatch(/sem confirmação por CPF/i));
    expect(container.textContent).not.toContain("51999990000");
    expect(container.textContent).not.toContain("12345678901");
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

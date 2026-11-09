// @vitest-environment jsdom
// Modo sob demanda (ficha da carteira): abrir NAO consulta a Mensageria; o clique
// consulta uma vez; cliques repetidos nao disparam outra consulta.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import BlocoUlbra from "./BlocoUlbra";
import { supabase } from "../services/supabase";

vi.mock("../services/supabase", () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "tok" } } }) },
    rpc: vi.fn(),
  },
}));
vi.stubEnv("VITE_SUPABASE_URL", "http://localhost:54321");

const ALUNO = { id: "aluno-1" };
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const consultasNaMensageria = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("ulbra-consultar")).length;

describe("BlocoUlbra sob demanda", () => {
  it("abrir a ficha: ZERO chamadas à Mensageria, só leitura do banco", async () => {
    supabase.rpc.mockResolvedValueOnce({ data: { status: "sem_vinculo" }, error: null });
    render(<BlocoUlbra aluno={ALUNO} sobDemanda />);
    await waitFor(() => expect(screen.getByText("Consultar vínculo na ULBRA")).toBeTruthy());
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith("ulbra_vinculo_aluno", { p_aluno_id: "aluno-1" });
    expect(consultasNaMensageria()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aviso curto de custo aparece junto do botão de consulta", async () => {
    supabase.rpc.mockResolvedValueOnce({ data: { status: "sem_vinculo" }, error: null });
    render(<BlocoUlbra aluno={ALUNO} sobDemanda />);
    await waitFor(() => expect(screen.getByText(/Consome 1 consulta na Mensageria ULBRA/)).toBeTruthy());
  });

  it("vínculo confirmado no banco: CRM ULBRA ↗ sem nenhuma chamada à Mensageria", async () => {
    supabase.rpc.mockResolvedValueOnce({
      data: { status: "vinculado", url: "https://crm.ulbra.ai/app/clientes/777" },
      error: null,
    });
    render(<BlocoUlbra aluno={ALUNO} sobDemanda />);
    const link = await waitFor(() => screen.getByRole("link", { name: /CRM ULBRA/ }));
    expect(link.getAttribute("href")).toBe("https://crm.ulbra.ai/app/clientes/777");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(consultasNaMensageria()).toBe(0);
  });

  it("vínculo sem confirmação por CPF: aviso, sem link e sem botão de consulta", async () => {
    supabase.rpc.mockResolvedValueOnce({ data: { status: "vinculado_nao_confirmado" }, error: null });
    render(<BlocoUlbra aluno={ALUNO} sobDemanda />);
    await waitFor(() => expect(screen.getByText(/Vínculo sem confirmação por CPF/)).toBeTruthy());
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Consultar vínculo na ULBRA")).toBeNull();
    expect(consultasNaMensageria()).toBe(0);
  });

  it("sem acesso ao aluno: nada na tela (sem botao, sem link, sem dado)", async () => {
    supabase.rpc.mockResolvedValueOnce({ data: { status: "sem_acesso" }, error: null });
    const { container } = render(<BlocoUlbra aluno={ALUNO} sobDemanda />);
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
    expect(screen.queryByText("Consultar vínculo na ULBRA")).toBeNull();
    expect(consultasNaMensageria()).toBe(0);
  });

  it("clique: exatamente UMA consulta à Mensageria", async () => {
    supabase.rpc.mockResolvedValueOnce({ data: { status: "sem_vinculo" }, error: null });
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ status: "vinculado", url: "https://crm.ulbra.ai/app/clientes/777", reconfirmar_recomendado: false }),
    });
    render(<BlocoUlbra aluno={ALUNO} sobDemanda />);
    fireEvent.click(await screen.findByText("Consultar vínculo na ULBRA"));
    await waitFor(() => expect(screen.getByRole("link", { name: /CRM ULBRA/ })).toBeTruthy());
    expect(consultasNaMensageria()).toBe(1);
  });

  it("cliques repetidos antes de voltar a resposta: continuam sendo UMA consulta", async () => {
    supabase.rpc.mockResolvedValueOnce({ data: { status: "sem_vinculo" }, error: null });
    let resolver;
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolver = r; }));
    render(<BlocoUlbra aluno={ALUNO} sobDemanda />);
    const botao = await screen.findByText("Consultar vínculo na ULBRA");
    fireEvent.click(botao);
    fireEvent.click(botao);
    fireEvent.click(botao);
    // a chamada sai depois de ler a sessão: espera existir antes de responder
    await waitFor(() => expect(consultasNaMensageria()).toBe(1));
    resolver({ json: async () => ({ status: "nao_encontrado", motivo: "NAO_ENCONTRADO" }) });
    await waitFor(() => expect(screen.getByText("Não encontrado na Mensageria Ulbra")).toBeTruthy());
    expect(consultasNaMensageria()).toBe(1);
  });

  it("não encontrado após o clique: mensagem de não encontrado, sem link", async () => {
    supabase.rpc.mockResolvedValueOnce({ data: { status: "sem_vinculo" }, error: null });
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ status: "nao_encontrado", motivo: "NAO_ENCONTRADO" }),
    });
    render(<BlocoUlbra aluno={ALUNO} sobDemanda />);
    fireEvent.click(await screen.findByText("Consultar vínculo na ULBRA"));
    await waitFor(() => expect(screen.getByText("Não encontrado na Mensageria Ulbra")).toBeTruthy());
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("bloqueio (só telefone) após o clique: mostra o motivo e nenhum link", async () => {
    supabase.rpc.mockResolvedValueOnce({ data: { status: "sem_vinculo" }, error: null });
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ status: "bloqueado", motivo: "CONFIRMACAO_MANUAL_SO_TELEFONE" }),
    });
    render(<BlocoUlbra aluno={ALUNO} sobDemanda />);
    fireEvent.click(await screen.findByText("Consultar vínculo na ULBRA"));
    await waitFor(() => expect(screen.getByText(/Encontrado só pelo telefone/)).toBeTruthy());
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("falha de rede no clique: mensagem de nova tentativa, e o botão volta", async () => {
    supabase.rpc.mockResolvedValueOnce({ data: { status: "sem_vinculo" }, error: null });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    render(<BlocoUlbra aluno={ALUNO} sobDemanda />);
    fireEvent.click(await screen.findByText("Consultar vínculo na ULBRA"));
    await waitFor(() => expect(screen.getByText(/Não foi possível consultar agora/)).toBeTruthy());
    expect(screen.getByText("Consultar vínculo na ULBRA")).toBeTruthy();
  });
});

describe("BlocoUlbra padrão (outras fichas): comportamento preservado", () => {
  it("continua consultando ao montar e mantém o rótulo antigo", async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ status: "vinculado", url: "https://crm.ulbra.ai/app/clientes/9", reconfirmar_recomendado: false }),
    });
    render(<BlocoUlbra aluno={ALUNO} />);
    await waitFor(() => expect(screen.getByRole("link", { name: /CRM ULBRA/ })).toBeTruthy());
    expect(consultasNaMensageria()).toBe(1);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

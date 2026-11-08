// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import NotificacoesUlbra from "./NotificacoesUlbra";
import { normalizarConversa } from "../utils/ulbraRespostas";

vi.mock("../services/supabase", () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "tok" } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        order: () => ({ limit: async () => ({ data: null, error: { message: "relation does not exist" } }) }),
      }),
      upsert: async () => ({ error: null }),
    }),
  },
}));

const EMAIL = "cobranca05@aelbra.com.br";
// Relativo ao agora REAL: o componente grava o marcador com `new Date()`, e
// fixture no futuro faria "abrir é ler" nunca zerar o contador.
const min = (n) => new Date(Date.now() - n * 60_000).toISOString();

function conversa(extra = {}, meta = {}) {
  return normalizarConversa(
    {
      id: "conv-1",
      canal: "whatsapp",
      situacao: "active",
      cliente: { id: "cli-1", nome: "Fulana de Tal" },
      equipe: "Única",
      ultimaMensagem: { quem: "cliente", em: min(5) },
      ...extra,
    },
    { responsavel_email: EMAIL, aluno_id: "aluno-1", aluno_nome: "Fulana de Tal", ...meta },
  );
}

const fonte = (itens) => () => Promise.resolve({ itens, indisponivel: false });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("NotificacoesUlbra", () => {
  it("não renderiza nada quando ninguém respondeu", async () => {
    const { container } = render(<NotificacoesUlbra email={EMAIL} carregar={fonte([])} />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("não avisa quando fomos NÓS que falamos por último", async () => {
    const { container } = render(
      <NotificacoesUlbra
        email={EMAIL}
        carregar={fonte([conversa({ ultimaMensagem: { quem: "operador", em: min(2) } })])}
      />,
    );
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("conta as respostas não lidas", async () => {
    render(
      <NotificacoesUlbra
        email={EMAIL}
        carregar={fonte([conversa({ id: "c1" }), conversa({ id: "c2" })])}
      />,
    );
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());
  });

  it("abrir é ler: o contador some e a lista continua", async () => {
    render(<NotificacoesUlbra email={EMAIL} carregar={fonte([conversa()])} />);
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Responderam/ }));

    await waitFor(() => expect(screen.getByText("Fulana de Tal")).toBeTruthy());
    expect(screen.queryByText("1")).toBeNull();
  });

  it("o operador não é avisado de aluno de outra carteira", async () => {
    const { container } = render(
      <NotificacoesUlbra
        email={EMAIL}
        carregar={fonte([conversa({}, { responsavel_email: "cobranca12@aelbra.com.br" })])}
      />,
    );
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("a gestão é avisada de todas as carteiras", async () => {
    render(
      <NotificacoesUlbra
        email="amanda.seibel@aelbra.com.br"
        gestao
        carregar={fonte([
          conversa({ id: "c1" }, { responsavel_email: EMAIL }),
          conversa({ id: "c2" }, { responsavel_email: "cobranca12@aelbra.com.br" }),
        ])}
      />,
    );
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());
  });

  it("entrega a conversa certa ao abrir", async () => {
    const onAbrir = vi.fn();
    render(<NotificacoesUlbra email={EMAIL} onAssumirLead={onAbrir} carregar={fonte([conversa()])} />);
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Responderam/ }));
    await waitFor(() => expect(screen.getByText("Fulana de Tal")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));

    expect(onAbrir).toHaveBeenCalledTimes(1);
    expect(onAbrir.mock.calls[0][0].conversa_id).toBe("conv-1");
  });

  it("modo simulado carimba SIMULADO e diz que não houve chamada real", async () => {
    render(<NotificacoesUlbra email={EMAIL} simulado />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Responderam/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Responderam/ }));
    await waitFor(() => expect(screen.getByText("SIMULADO")).toBeTruthy());
    expect(screen.getByText(/nenhuma mensagem enviada/i)).toBeTruthy();
  });

  it("modo real NÃO carimba SIMULADO e explica o sinal", async () => {
    render(<NotificacoesUlbra email={EMAIL} carregar={fonte([conversa()])} />);
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Responderam/ }));
    await waitFor(() => expect(screen.getByText(/última mensagem da conversa é do aluno/i)).toBeTruthy());
    expect(screen.queryByText("SIMULADO")).toBeNull();
  });

  it("fonte real sem a migration aplicada diz que não está ligada, em vez de mostrar zero", async () => {
    render(<NotificacoesUlbra email={EMAIL} />);
    await waitFor(() => expect(screen.getByText(/fonte não ligada/i)).toBeTruthy());
  });

  it("fonte que levanta não quebra a barra lateral", async () => {
    render(<NotificacoesUlbra email={EMAIL} carregar={() => Promise.reject(new Error("fora do ar"))} />);
    await waitFor(() => expect(screen.getByText(/fonte não ligada/i)).toBeTruthy());
  });
});

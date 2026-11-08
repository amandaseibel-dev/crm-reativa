// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import NotificacoesUlbra from "./NotificacoesUlbra";
import { carregarReal } from "../utils/ulbraRespostasFonte";
import {
  EQUIPE_REATIVA,
  SITUACAO_ESPERANDO,
  normalizarAtendimento,
} from "../utils/ulbraRespostas";

vi.mock("../services/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "tok123" } } }),
    },
  },
}));

vi.stubEnv("VITE_SUPABASE_URL", "http://localhost:54321");

const EMAIL = "cobranca05@aelbra.com.br";

// Relativo ao agora REAL, não a um instante fixo: o componente grava o
// marcador de leitura com `new Date()`, então fixture no futuro faria
// "abrir é ler" nunca zerar o contador. Data absoluta em fixture já derrubou
// o CI deste repositório antes.
const min = (n) => new Date(Date.now() - n * 60_000).toISOString();

// A fonte devolve itens NORMALIZADOS, como `amostraSimulada` e `carregarReal`.
function atendimento(extra = {}) {
  return normalizarAtendimento({
    id: "a1",
    aluno_nome: "Fulana de Tal",
    responsavel_email: EMAIL,
    equipe: EQUIPE_REATIVA,
    situacao: SITUACAO_ESPERANDO,
    entrou_em: min(60),
    atualizado_em: min(5),
    ...extra,
  });
}

// Fonte injetada: a etapa 1 não fala com a Mensageria, então o teste também não.
const fonte = (itens) => () => Promise.resolve(itens.map((i) => ({ ...i })));

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("NotificacoesUlbra", () => {
  it("não renderiza nada quando ninguém está esperando", async () => {
    const { container } = render(
      <NotificacoesUlbra email={EMAIL} carregar={fonte([])} />,
    );
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("não renderiza quem já foi aceito — só 'waiting' é resposta esperando", async () => {
    const { container } = render(
      <NotificacoesUlbra email={EMAIL} carregar={fonte([atendimento({ situacao: "accepted" })])} />,
    );
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("mostra o contador de não lidas", async () => {
    render(
      <NotificacoesUlbra
        email={EMAIL}
        carregar={fonte([atendimento({ id: "a1" }), atendimento({ id: "a2" })])}
      />,
    );
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());
  });

  it("abrir é ler: o contador some e a lista continua", async () => {
    render(<NotificacoesUlbra email={EMAIL} carregar={fonte([atendimento()])} />);
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Responderam/ }));

    await waitFor(() => expect(screen.getByText("Fulana de Tal")).toBeTruthy());
    expect(screen.queryByText("1")).toBeNull();
  });

  it("o marcador de leitura persiste por usuário no localStorage", async () => {
    render(<NotificacoesUlbra email={EMAIL} carregar={fonte([atendimento()])} />);
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Responderam/ }));

    await waitFor(() =>
      expect(localStorage.getItem(`ulbra_respostas_visto_em:${EMAIL}`)).toBeTruthy(),
    );
  });

  it("o operador não é avisado do aluno de outra carteira", async () => {
    const { container } = render(
      <NotificacoesUlbra
        email={EMAIL}
        carregar={fonte([atendimento({ responsavel_email: "cobranca12@aelbra.com.br" })])}
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
          atendimento({ id: "a1", responsavel_email: EMAIL }),
          atendimento({ id: "a2", responsavel_email: "cobranca12@aelbra.com.br" }),
        ])}
      />,
    );
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());
  });

  it("chama onAssumirLead com o atendimento certo", async () => {
    const onAssumir = vi.fn();
    render(
      <NotificacoesUlbra email={EMAIL} onAssumirLead={onAssumir} carregar={fonte([atendimento()])} />,
    );
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Responderam/ }));
    await waitFor(() => expect(screen.getByText("Fulana de Tal")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Assumir" }));

    expect(onAssumir).toHaveBeenCalledTimes(1);
    expect(onAssumir.mock.calls[0][0].atendimento_id).toBe("a1");
  });

  it("em modo simulado o painel traz o selo SIMULADO", async () => {
    render(<NotificacoesUlbra email={EMAIL} simulado />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Responderam/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Responderam/ }));
    await waitFor(() => expect(screen.getByText("SIMULADO")).toBeTruthy());
  });

  it("o painel diz que isto não é leitura de conversa", async () => {
    render(<NotificacoesUlbra email={EMAIL} carregar={fonte([atendimento()])} />);
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Responderam/ }));
    await waitFor(() =>
      expect(screen.getByText(/não expõe\s+mensagens/i)).toBeTruthy(),
    );
  });

  it("fonte que falha não quebra a barra lateral", async () => {
    const { container } = render(
      <NotificacoesUlbra email={EMAIL} carregar={() => Promise.reject(new Error("fora do ar"))} />,
    );
    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});

describe("carregarReal (etapa 2)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("NAO_RECEPTIVO devolve lista vazia, sem erro", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ motivo: "NAO_RECEPTIVO" }) }));
    expect(await carregarReal()).toEqual([]);
  });

  it("converte o formato da ulbra-leads-pendentes, que não traz responsável", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ leads: [{ id: "lead-1", nome: "Ângela", criado_em: min(20) }] }),
    }));
    const r = await carregarReal();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      atendimento_id: "lead-1",
      aluno_nome: "Ângela",
      situacao: SITUACAO_ESPERANDO,
      responsavel_email: null,
    });
  });
});

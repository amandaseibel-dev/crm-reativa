// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import LeadsWhatsApp from "./LeadsWhatsApp";

const servico = vi.hoisted(() => ({ canais: [], leads: [], registrados: [] }));

vi.mock("../services/whatsapp", async (original) => {
  const real = await original();
  return {
    ...real,
    listarCanais: vi.fn(async () => servico.canais),
    listarLeads: vi.fn(async () => servico.leads),
    registrarLead: vi.fn(async (dados) => {
      servico.registrados.push(dados);
      return "novo-id";
    }),
    atualizarLead: vi.fn(async () => {}),
  };
});

function lead(extra = {}) {
  return {
    id: "l1",
    telefone_e164: "5551999998888",
    nome: "Fulano",
    canal_id: "c1",
    canal_apelido: "Cobrança",
    assunto: "Quer negociar a dívida",
    observacao: null,
    status: "NOVO",
    operador_email: null,
    registrado_por_email: "cobranca01@aelbra.com.br",
    registrado_em: new Date().toISOString(),
    ...extra,
  };
}

beforeEach(() => {
  servico.canais = [];
  servico.leads = [];
  servico.registrados = [];
});

afterEach(() => cleanup());

describe("Leads do WhatsApp", () => {
  it("deixa claro que a tela NAO envia mensagem", async () => {
    render(<LeadsWhatsApp />);
    expect(await screen.findByText(/não envia mensagem/)).toBeDefined();
  });

  it("mostra estado vazio", async () => {
    render(<LeadsWhatsApp />);
    expect(await screen.findByText(/Nenhum lead registrado ainda/)).toBeDefined();
  });

  it("lista o lead com telefone formatado e qual número recebeu", async () => {
    servico.leads = [lead()];
    render(<LeadsWhatsApp />);
    expect(await screen.findByText("Fulano")).toBeDefined();
    expect(screen.getByText(/\+55 \(51\) 99999-8888/)).toBeDefined();
    expect(screen.getByText(/recebido em Cobrança/)).toBeDefined();
    expect(screen.getByText("Quer negociar a dívida")).toBeDefined();
  });

  it("o botao de WhatsApp aponta para o numero certo", async () => {
    servico.leads = [lead()];
    render(<LeadsWhatsApp />);
    const link = await screen.findByText("Abrir WhatsApp");
    expect(link.getAttribute("href")).toBe("https://wa.me/5551999998888");
  });

  it("bloqueia o registro enquanto o telefone estiver incompleto", async () => {
    render(<LeadsWhatsApp />);
    const campo = await screen.findByPlaceholderText("Telefone com DDD *");
    fireEvent.change(campo, { target: { value: "9999" } });

    expect(screen.getByText(/Telefone incompleto/)).toBeDefined();
    expect(screen.getByText("Registrar").disabled).toBe(true);
  });

  it("registra quando o telefone está completo", async () => {
    render(<LeadsWhatsApp />);
    fireEvent.change(await screen.findByPlaceholderText("Telefone com DDD *"), {
      target: { value: "51999998888" },
    });
    fireEvent.change(screen.getByPlaceholderText("Nome (se souber)"), {
      target: { value: "Maria" },
    });
    fireEvent.click(screen.getByText("Registrar"));

    await waitFor(() => expect(servico.registrados.length).toBe(1));
    expect(servico.registrados[0].telefone).toBe("51999998888");
    expect(servico.registrados[0].nome).toBe("Maria");
  });

  it("avisa quando o telefone já tinha lead aberto (nao duplica)", async () => {
    servico.leads = [lead()];
    render(<LeadsWhatsApp />);
    fireEvent.change(await screen.findByPlaceholderText("Telefone com DDD *"), {
      target: { value: "51999998888" },
    });
    fireEvent.click(screen.getByText("Registrar"));

    // a lista nao cresceu -> a RPC devolveu o lead existente
    expect(await screen.findByText(/Já havia um lead aberto/)).toBeDefined();
  });

  it("conta quem está esperando resposta e destaca os de mais de 24h", async () => {
    servico.leads = [
      lead({ id: "a", status: "NOVO", registrado_em: new Date(Date.now() - 30 * 3600 * 1000).toISOString() }),
      lead({ id: "b", status: "EM_ATENDIMENTO", registrado_em: new Date().toISOString() }),
      lead({ id: "c", status: "RESPONDIDO" }),
      lead({ id: "d", status: "ENCERRADO" }),
    ];
    render(<LeadsWhatsApp />);

    // respondido e encerrado nao contam como esperando
    const contador = await screen.findByText(/esperando resposta/);
    expect(contador.textContent).toBe("2 esperando resposta · 1 há mais de 24h");
  });

  it("mostra há quanto tempo o lead espera, e só para quem espera", async () => {
    servico.leads = [
      lead({ id: "a", nome: "Ana", status: "NOVO", registrado_em: new Date(Date.now() - 5 * 3600 * 1000).toISOString() }),
      lead({ id: "b", nome: "Bruno", status: "RESPONDIDO" }),
    ];
    render(<LeadsWhatsApp />);

    // quem espera: mostra o tempo
    const linhaAna = await screen.findByTestId("lead-a");
    expect(within(linhaAna).getByText("esperando 5h")).toBeDefined();

    // quem já foi respondido: mostra o status, sem tempo de espera
    const linhaBruno = screen.getByTestId("lead-b");
    expect(within(linhaBruno).getByText("Respondido")).toBeDefined();
    expect(within(linhaBruno).queryByText(/esperando/)).toBeNull();
  });

  it("só oferece o filtro de número quando há canais cadastrados", async () => {
    render(<LeadsWhatsApp />);
    await screen.findByText(/Nenhum lead registrado ainda/);
    expect(screen.queryByText("Qual número recebeu?")).toBeNull();

    cleanup();
    servico.canais = [
      { id: "c1", apelido: "Cobrança", display_phone_number: "+55 51 1111-1111", ativo: true },
    ];
    render(<LeadsWhatsApp />);
    expect(await screen.findByText("Qual número recebeu?")).toBeDefined();
  });
});

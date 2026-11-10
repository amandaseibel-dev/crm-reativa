// @vitest-environment jsdom
// Tela de conversa: exibição, envio único por clique, bloqueio sem conexão e
// mensagens de falha. PROVA SIMULADA: onEnviar é um dublê; não é envio real.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import ConversaUlbra from "./ConversaUlbra";

afterEach(() => cleanup());

const mensagens = [
  { direcao: "ENTRADA", em: "2026-11-09T13:01:00Z", texto: "Oi, preciso do boleto", autor: null, anexos: [] },
  { direcao: "SAIDA", em: "2026-11-09T13:02:00Z", texto: "Claro, já envio", autor: "João", anexos: [] },
];

describe("exibição", () => {
  it("mostra direção, texto e horário de cada mensagem", () => {
    render(<ConversaUlbra mensagens={mensagens} podeEnviar />);
    expect(screen.getByText("Oi, preciso do boleto")).toBeTruthy();
    expect(screen.getByText("Claro, já envio")).toBeTruthy();
    expect(screen.getByText(/Aluno/)).toBeTruthy();
    expect(screen.getByText(/João/)).toBeTruthy();
  });

  it("sem conexão individual, mostra o bloqueio e não deixa enviar", () => {
    render(<ConversaUlbra mensagens={mensagens} podeEnviar={false} />);
    expect(screen.getByText(/conecte sua conta/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enviar resposta" }).disabled).toBe(true);
  });
});

describe("envio", () => {
  it("um clique repetido envia UMA vez, com a mesma chave", async () => {
    let resolver;
    const onEnviar = vi.fn(() => new Promise((r) => { resolver = r; }));
    render(<ConversaUlbra mensagens={[]} podeEnviar onEnviar={onEnviar} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "Olá" } });
    const botao = screen.getByRole("button", { name: "Enviar resposta" });
    fireEvent.click(botao);
    fireEvent.click(botao);
    fireEvent.submit(botao.closest("form"));
    expect(onEnviar).toHaveBeenCalledTimes(1);
    resolver({ situacao: "PROCESSADO", envio: { status: "ENVIADO" } });
    await waitFor(() => expect(screen.getByLabelText("Resposta").value).toBe(""));
  });

  it("recusa da Mensageria mostra aviso e mantém o texto", async () => {
    const onEnviar = vi.fn(async () => ({ situacao: "PROCESSADO", envio: { status: "RECUSADO" } }));
    render(<ConversaUlbra mensagens={[]} podeEnviar onEnviar={onEnviar} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "Olá" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar resposta" }));
    expect(await screen.findByText(/A Mensageria recusou/)).toBeTruthy();
    expect(screen.getByLabelText("Resposta").value).toBe("Olá");
  });

  it("falha incerta pede conferência e não sugere reenvio automático", async () => {
    const onEnviar = vi.fn(async () => ({ situacao: "PROCESSADO", envio: { status: "FALHA_INCERTA" } }));
    render(<ConversaUlbra mensagens={[]} podeEnviar onEnviar={onEnviar} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "Olá" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar resposta" }));
    expect(await screen.findByText(/pode ter saído/)).toBeTruthy();
  });

  it("bloqueio do servidor mostra o motivo", async () => {
    const onEnviar = vi.fn(async () => ({ situacao: "BLOQUEADO", motivos: ["SEM_CONEXAO_INDIVIDUAL"] }));
    render(<ConversaUlbra mensagens={[]} podeEnviar onEnviar={onEnviar} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "Olá" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar resposta" }));
    expect(await screen.findByText(/SEM_CONEXAO_INDIVIDUAL/)).toBeTruthy();
  });
});

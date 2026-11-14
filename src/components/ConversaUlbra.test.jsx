// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import ConversaUlbra from "./ConversaUlbra";

afterEach(cleanup);

const MSGS = [
  { direcao: "ENTRADA", em: "2026-11-10T13:00:00Z", texto: "pode me ligar?", autor: null, anexos: [] },
  { direcao: "SAIDA", em: "2026-11-10T13:05:00Z", texto: "claro", autor: "Olga", anexos: ["boleto.pdf"] },
];

const PREVIA_OK = { ok: true, previa_id: "prev-1", expira_em_ms: Date.parse("2026-11-10T13:10:00Z"), janela_aberta: true };

describe("ConversaUlbra — apresentação", () => {
  it("mostra as mensagens com direção, autor, hora e anexos; sem permissão de envio, avisa e desabilita", () => {
    render(<ConversaUlbra mensagens={MSGS} podeEnviar={false} />);
    expect(screen.getByText("pode me ligar?")).toBeTruthy();
    expect(screen.getByText(/Anexos: boleto.pdf/)).toBeTruthy();
    expect(screen.getByText(/conecte sua conta da Mensageria/)).toBeTruthy();
    expect(screen.getByLabelText("Resposta").disabled).toBe(true);
  });

  it("com cursor, oferece carregar anteriores", () => {
    const onAnt = vi.fn();
    render(<ConversaUlbra mensagens={MSGS} antesDe="c9" onCarregarAnteriores={onAnt} />);
    fireEvent.click(screen.getByText(/Carregar mensagens anteriores \(1 chamada\)/));
    expect(onAnt).toHaveBeenCalledWith("c9");
  });

  it("não há seleção de template nesta entrega", () => {
    render(<ConversaUlbra mensagens={MSGS} podeEnviar />);
    expect(document.querySelector("select")).toBeNull();
    expect(screen.queryByText(/template/i)).toBeNull();
  });
});

describe("ConversaUlbra — envio em duas etapas (texto livre)", () => {
  it("1) 'Ver prévia' chama onPrevia com o texto e mostra a validade, sem custo; 2) 'Confirmar envio' passa a prévia (previa_id) e UMA chave", async () => {
    const onPrevia = vi.fn().mockResolvedValue(PREVIA_OK);
    const onEnviar = vi.fn().mockResolvedValue({ situacao: "PROCESSADO", envio: { status: "ENVIADO" } });
    render(<ConversaUlbra mensagens={MSGS} podeEnviar onPrevia={onPrevia} onEnviar={onEnviar} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "Bom dia, segue o boleto." } });
    fireEvent.click(screen.getByText("Ver prévia"));
    await waitFor(() => expect(screen.getByText(/Prévia registrada no ReATIVA/)).toBeTruthy());
    expect(onPrevia).toHaveBeenCalledWith("Bom dia, segue o boleto.");
    expect(screen.queryByText(/US\$/)).toBeNull();
    expect(onEnviar).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector("[data-campo='confirmar']"));
    await waitFor(() => expect(onEnviar).toHaveBeenCalledTimes(1));
    const [texto, chave, previa] = onEnviar.mock.calls[0];
    expect(texto).toBe("Bom dia, segue o boleto.");
    expect(typeof chave).toBe("string");
    expect(previa.previa_id).toBe("prev-1");
  });

  it("mudar o texto depois da prévia invalida a prévia: a confirmação some", async () => {
    const onPrevia = vi.fn().mockResolvedValue(PREVIA_OK);
    render(<ConversaUlbra mensagens={MSGS} podeEnviar onPrevia={onPrevia} onEnviar={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText("Ver prévia"));
    await waitFor(() => expect(document.querySelector("[data-campo='confirmar']")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "oi, mudei" } });
    expect(document.querySelector("[data-campo='confirmar']")).toBeNull();
  });

  it("bloqueio do servidor mostra os motivos e não limpa o texto", async () => {
    const onPrevia = vi.fn().mockResolvedValue(PREVIA_OK);
    const onEnviar = vi.fn().mockResolvedValue({ situacao: "BLOQUEADO", motivos: ["PREVIA_EXPIRADA"] });
    render(<ConversaUlbra mensagens={MSGS} podeEnviar onPrevia={onPrevia} onEnviar={onEnviar} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText("Ver prévia"));
    await waitFor(() => expect(document.querySelector("[data-campo='confirmar']")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-campo='confirmar']"));
    await waitFor(() => expect(screen.getByText(/Envio bloqueado: PREVIA_EXPIRADA/)).toBeTruthy());
    expect(screen.getByLabelText("Resposta").value).toBe("oi");
  });

  it("falha incerta mantém o texto e avisa para conferir antes de reenviar", async () => {
    const onPrevia = vi.fn().mockResolvedValue(PREVIA_OK);
    const onEnviar = vi.fn().mockResolvedValue({ situacao: "PROCESSADO", envio: { status: "FALHA_INCERTA" } });
    render(<ConversaUlbra mensagens={MSGS} podeEnviar onPrevia={onPrevia} onEnviar={onEnviar} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText("Ver prévia"));
    await waitFor(() => expect(document.querySelector("[data-campo='confirmar']")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-campo='confirmar']"));
    await waitFor(() => expect(screen.getByText(/pode ter saído/)).toBeTruthy());
    expect(screen.getByLabelText("Resposta").value).toBe("oi");
  });

  it("prévia recusada pelo servidor não oferece confirmação", async () => {
    const onPrevia = vi.fn().mockResolvedValue({ ok: false, recusa: "JANELA_FECHADA" });
    render(<ConversaUlbra mensagens={MSGS} podeEnviar onPrevia={onPrevia} onEnviar={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText("Ver prévia"));
    await waitFor(() => expect(screen.getByText(/não aceita este envio: JANELA_FECHADA/)).toBeTruthy());
    expect(document.querySelector("[data-campo='confirmar']")).toBeNull();
  });
});

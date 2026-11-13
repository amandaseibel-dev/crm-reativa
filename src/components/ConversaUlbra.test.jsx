// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import ConversaUlbra from "./ConversaUlbra";

afterEach(cleanup);

const MSGS = [
  { direcao: "ENTRADA", em: "2026-11-10T13:00:00Z", texto: "pode me ligar?", autor: null, anexos: [] },
  { direcao: "SAIDA", em: "2026-11-10T13:05:00Z", texto: "claro", autor: "Olga", anexos: ["boleto.pdf"] },
];

describe("ConversaUlbra — apresentação", () => {
  it("mostra as mensagens com direção, autor, hora e anexos; sem permissão de envio, avisa e desabilita", () => {
    render(<ConversaUlbra mensagens={MSGS} podeEnviar={false} />);
    expect(screen.getByText("pode me ligar?")).toBeTruthy();
    expect(screen.getByText(/Anexos: boleto.pdf/)).toBeTruthy();
    expect(screen.getByText(/conecte sua conta da Mensageria/)).toBeTruthy();
    expect(screen.getByLabelText("Resposta").disabled).toBe(true);
  });
  it("com cursor, oferece carregar anteriores e informa o custo", () => {
    const onAnt = vi.fn();
    render(<ConversaUlbra mensagens={MSGS} antesDe="c9" onCarregarAnteriores={onAnt} />);
    fireEvent.click(screen.getByText(/Carregar mensagens anteriores \(1 chamada\)/));
    expect(onAnt).toHaveBeenCalledWith("c9");
  });
});

describe("ConversaUlbra — envio em duas etapas", () => {
  it("1) escrever + 'Ver prévia' chama onPrevia e mostra custo e janela; 2) 'Confirmar envio' chama onEnviar com UMA chave e a prévia", async () => {
    const onPrevia = vi.fn().mockResolvedValue({ ok: true, custo_usd: 0.0123, janela_aberta: true, em: "2026-11-11T15:00:00Z" });
    const onEnviar = vi.fn().mockResolvedValue({ situacao: "PROCESSADO", envio: { status: "ENVIADO" } });
    render(<ConversaUlbra mensagens={MSGS} podeEnviar onPrevia={onPrevia} onEnviar={onEnviar} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "  Bom dia, segue o boleto.  " } });
    expect(screen.queryByText(/Confirmar envio/)).toBeNull(); // nada de enviar antes da prévia
    fireEvent.click(screen.getByText(/Ver prévia/));
    await waitFor(() => expect(onPrevia).toHaveBeenCalledWith("Bom dia, segue o boleto."));
    expect(onEnviar).not.toHaveBeenCalled();
    const previa = await screen.findByText(/Prévia da Mensageria/);
    expect(previa.parentElement.textContent).toMatch(/US\$ 0\.0123/);
    expect(previa.parentElement.textContent).toMatch(/janela de 24 h: aberta/);
    fireEvent.click(screen.getByText("Confirmar envio"));
    await waitFor(() => expect(onEnviar).toHaveBeenCalledTimes(1));
    const [texto, chave, prev] = onEnviar.mock.calls[0];
    expect(texto).toBe("Bom dia, segue o boleto.");
    expect(chave.length).toBeGreaterThanOrEqual(8);
    expect(prev).toMatchObject({ custo_usd: 0.0123, janela_aberta: true });
    expect(await screen.findByText(/Mensagem enviada em seu nome/)).toBeTruthy();
    expect(screen.getByLabelText("Resposta").value).toBe("");
  });
  it("prévia recusada pela Mensageria não oferece confirmação", async () => {
    const onPrevia = vi.fn().mockResolvedValue({ ok: false, recusa: "janela de 24h fechada", custo_usd: null, janela_aberta: false });
    const onEnviar = vi.fn();
    render(<ConversaUlbra podeEnviar onPrevia={onPrevia} onEnviar={onEnviar} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText(/Ver prévia/));
    expect(await screen.findByText(/não aceita este envio: janela de 24h fechada/)).toBeTruthy();
    expect(screen.queryByText("Confirmar envio")).toBeNull();
    expect(onEnviar).not.toHaveBeenCalled();
  });
  it("mudar o texto depois da prévia invalida a prévia; falha incerta mantém a chave e não limpa o texto", async () => {
    const onPrevia = vi.fn().mockResolvedValue({ ok: true, custo_usd: 0.01, janela_aberta: true });
    const onEnviar = vi.fn().mockResolvedValueOnce({ situacao: "PROCESSADO", envio: { status: "FALHA_INCERTA" } }).mockResolvedValueOnce({ situacao: "JA_PROCESSADO", envio: { status: "ENVIADO" } });
    render(<ConversaUlbra podeEnviar onPrevia={onPrevia} onEnviar={onEnviar} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText(/Ver prévia/));
    await screen.findByText("Confirmar envio");
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "oi!" } });
    expect(screen.queryByText("Confirmar envio")).toBeNull();
    fireEvent.click(screen.getByText(/Ver prévia/));
    await screen.findByText("Confirmar envio");
    fireEvent.click(screen.getByText("Confirmar envio"));
    expect(await screen.findByText(/pode ter saído/)).toBeTruthy();
    expect(screen.getByLabelText("Resposta").value).toBe("oi!");
    fireEvent.click(screen.getByText("Confirmar envio"));
    await waitFor(() => expect(onEnviar).toHaveBeenCalledTimes(2));
    expect(onEnviar.mock.calls[0][1]).toBe(onEnviar.mock.calls[1][1]); // mesma chave: idempotente
    expect(await screen.findByText(/já tinha sido processado/)).toBeTruthy();
  });
  it("bloqueio do servidor mostra os motivos e não limpa nada", async () => {
    const onPrevia = vi.fn().mockResolvedValue({ ok: true, custo_usd: 0.01, janela_aberta: true });
    const onEnviar = vi.fn().mockResolvedValue({ situacao: "BLOQUEADO", motivos: ["ENVIO_REAL_NAO_CONFIRMADO"] });
    render(<ConversaUlbra podeEnviar onPrevia={onPrevia} onEnviar={onEnviar} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText(/Ver prévia/));
    fireEvent.click(await screen.findByText("Confirmar envio"));
    expect(await screen.findByText(/Envio bloqueado: ENVIO_REAL_NAO_CONFIRMADO/)).toBeTruthy();
    expect(screen.getByLabelText("Resposta").value).toBe("oi");
  });
});

describe("ConversaUlbra — template fora da janela (lista aprovada)", () => {
  it("sem templates aprovados: mostra o aviso, não oferece seleção e mantém o envio bloqueado fora da janela", () => {
    render(<ConversaUlbra mensagens={MSGS} podeEnviar templatesAprovados={[]} />);
    expect(screen.getByText(/Nenhum template aprovado está disponível/)).toBeTruthy();
    expect(document.querySelector("[data-campo='template-select']")).toBeNull();
  });

  it("com templates aprovados: oferece a seleção e não exige texto livre quando há template", async () => {
    const onPrevia = vi.fn().mockResolvedValue({ ok: true, custo_usd: 0.01, janela_aberta: false });
    render(<ConversaUlbra mensagens={MSGS} podeEnviar templatesAprovados={["aviso_retorno"]} onPrevia={onPrevia} />);
    const select = document.querySelector("[data-campo='template-select']");
    expect(select).toBeTruthy();
    fireEvent.change(select, { target: { value: "aviso_retorno" } });
    fireEvent.change(document.querySelector("[data-campo='template-variaveis']"), { target: { value: "Maria; 10/11" } });
    fireEvent.click(screen.getByText(/Ver prévia/));
    await waitFor(() => expect(onPrevia).toHaveBeenCalledTimes(1));
    expect(onPrevia).toHaveBeenCalledWith("", { nome: "aviso_retorno", variaveis: ["Maria", "10/11"] });
  });

  it("janela fechada sem template escolhido: não deixa confirmar, pede o template", async () => {
    const onPrevia = vi.fn().mockResolvedValue({ ok: true, custo_usd: 0.01, janela_aberta: false });
    render(<ConversaUlbra mensagens={MSGS} podeEnviar templatesAprovados={["aviso_retorno"]} onPrevia={onPrevia} />);
    fireEvent.change(screen.getByLabelText("Resposta"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText(/Ver prévia/));
    await waitFor(() => expect(screen.getByText(/Escolha um template aprovado para enviar/)).toBeTruthy());
    expect(document.querySelector("[data-campo='confirmar']")).toBeNull();
  });

  it("confirmar com template chama onEnviar com o template e UMA chave", async () => {
    const onPrevia = vi.fn().mockResolvedValue({ ok: true, custo_usd: 0.01, janela_aberta: false });
    const onEnviar = vi.fn().mockResolvedValue({ situacao: "PROCESSADO", envio: { status: "ENVIADO" } });
    render(<ConversaUlbra mensagens={MSGS} podeEnviar templatesAprovados={["aviso_retorno"]} onPrevia={onPrevia} onEnviar={onEnviar} />);
    fireEvent.change(document.querySelector("[data-campo='template-select']"), { target: { value: "aviso_retorno" } });
    fireEvent.change(document.querySelector("[data-campo='template-variaveis']"), { target: { value: "Maria" } });
    fireEvent.click(screen.getByText(/Ver prévia/));
    await waitFor(() => expect(document.querySelector("[data-campo='confirmar']")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-campo='confirmar']"));
    await waitFor(() => expect(onEnviar).toHaveBeenCalledTimes(1));
    const [texto, chave, previa, template] = onEnviar.mock.calls[0];
    expect(texto).toBe("");
    expect(typeof chave).toBe("string");
    expect(previa.janela_aberta).toBe(false);
    expect(template).toEqual({ nome: "aviso_retorno", variaveis: ["Maria"] });
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import HistoricoFichaAluno from "./HistoricoFichaAluno";

// Acesso: qualquer operador com sessão vê o botão; o servidor decide o resto.
const OPERADOR = "cobranca10@aelbra.com.br";

const RESPOSTA = {
  ok: true,
  consultado_em: "2026-11-13T12:30:00Z",
  saldo: { restam: 9000, medido_em: "2026-11-13T12:00:00Z" },
  pagina: { mensagens: [{ direcao: "ENTRADA", em: "2026-11-11T10:00:00Z", texto: "pode me ligar?", autor: null, anexos: [] }], antes_de: null },
};

afterEach(() => cleanup());

describe("ficha: histórico só por clique, com data da consulta e das mensagens", () => {
  it("sem sessão (sem e-mail): nada aparece e nada é chamado", async () => {
    const leitor = vi.fn();
    render(<HistoricoFichaAluno alunoId="A1" emailUsuario="" leitor={leitor} />);
    expect(screen.queryByTestId("historico-ficha")).toBeNull();
    expect(leitor).not.toHaveBeenCalled();
  });

  it("qualquer operador com sessão vê o botão (quem lê é decidido no servidor)", async () => {
    const leitor = vi.fn().mockResolvedValue(RESPOSTA);
    render(<HistoricoFichaAluno alunoId="A1" emailUsuario="outro@aelbra.com.br" leitor={leitor} />);
    expect(screen.getByTestId("historico-ficha")).toBeTruthy();
    expect(leitor).not.toHaveBeenCalled();
  });

  it("mostra o saldo da cota e quando foi medido", async () => {
    const leitor = vi.fn().mockResolvedValue(RESPOSTA);
    render(<HistoricoFichaAluno alunoId="A1" emailUsuario={OPERADOR} leitor={leitor} />);
    fireEvent.click(screen.getByRole("button", { name: /Consultar conversa/ }));
    await waitFor(() => expect(screen.getByTestId("historico-ficha").textContent).toMatch(/Saldo da cota: 9000/));
  });

  it("abrir a ficha não chama a Mensageria; só o clique chama, uma vez", async () => {
    const leitor = vi.fn().mockResolvedValue(RESPOSTA);
    render(<HistoricoFichaAluno alunoId="A1" emailUsuario={OPERADOR} leitor={leitor} />);
    expect(screen.getByTestId("historico-ficha")).toBeTruthy();
    expect(leitor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Consultar conversa/ }));
    await waitFor(() => expect(screen.getByText("pode me ligar?")).toBeTruthy());
    expect(leitor).toHaveBeenCalledTimes(1);
    expect(leitor).toHaveBeenCalledWith("A1", null);
  });

  it("mostra a data e a hora da consulta e de cada mensagem, sem apresentar como espelho", async () => {
    const leitor = vi.fn().mockResolvedValue(RESPOSTA);
    render(<HistoricoFichaAluno alunoId="A1" emailUsuario={OPERADOR} leitor={leitor} />);
    fireEvent.click(screen.getByRole("button", { name: /Consultar conversa/ }));
    await waitFor(() => expect(screen.getByTestId("historico-ficha").textContent).toMatch(/Consultado na Mensageria em/));
    const texto = screen.getByTestId("historico-ficha").textContent;
    expect(texto).toMatch(/13\/11\/2026/);
    expect(texto).toMatch(/11\/11\/2026/);
    expect(texto).toMatch(/Não é um espelho salvo/);
  });

  it("recusa do servidor vira texto explicativo e não repete a consulta", async () => {
    const leitor = vi.fn().mockResolvedValue({ ok: false, motivo: "LIMITE_OPERADOR_DIA", http: 200 });
    render(<HistoricoFichaAluno alunoId="A1" emailUsuario={OPERADOR} leitor={leitor} />);
    fireEvent.click(screen.getByRole("button", { name: /Consultar conversa/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/limite diário/);
    expect(leitor).toHaveBeenCalledTimes(1);
  });

  it("429 aparece como parada, sem nova tentativa", async () => {
    const leitor = vi.fn().mockResolvedValue({ ok: false, motivo: "ULBRA_LIMITE", http: 200 });
    render(<HistoricoFichaAluno alunoId="A1" emailUsuario={OPERADOR} leitor={leitor} />);
    fireEvent.click(screen.getByRole("button", { name: /Consultar conversa/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/429/);
    expect(leitor).toHaveBeenCalledTimes(1);
  });


});

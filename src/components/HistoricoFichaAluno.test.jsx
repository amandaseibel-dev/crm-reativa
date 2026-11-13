// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import HistoricoFichaAluno from "./HistoricoFichaAluno";
import { HISTORICO_FICHA_PILOTO_EMAILS } from "../utils/ulbraHistorico";

// Piloto: a lista começa vazia. Estes testes provam o comportamento com um e-mail
// autorizado sem alterar a lista do código: ela é lida pela própria função.
const PILOTO = "cobranca10@aelbra.com.br";
vi.mock("../utils/ulbraHistorico", async (orig) => {
  const real = await orig();
  return { ...real, podeVerHistoricoNaFicha: (e) => String(e ?? "").toLowerCase() === "cobranca10@aelbra.com.br" };
});

const RESPOSTA = {
  ok: true,
  consultado_em: "2026-11-13T12:30:00Z",
  pagina: { mensagens: [{ direcao: "ENTRADA", em: "2026-11-11T10:00:00Z", texto: "pode me ligar?", autor: null, anexos: [] }], antes_de: null },
};

afterEach(() => cleanup());

describe("ficha: histórico só por clique, com data da consulta e das mensagens", () => {
  it("e-mail fora do piloto: nada aparece e nada é chamado", async () => {
    const leitor = vi.fn();
    render(<HistoricoFichaAluno alunoId="A1" emailUsuario="outro@aelbra.com.br" leitor={leitor} />);
    expect(screen.queryByTestId("historico-ficha")).toBeNull();
    expect(leitor).not.toHaveBeenCalled();
  });

  it("abrir a ficha não chama a Mensageria; só o clique chama, uma vez", async () => {
    const leitor = vi.fn().mockResolvedValue(RESPOSTA);
    render(<HistoricoFichaAluno alunoId="A1" emailUsuario={PILOTO} leitor={leitor} />);
    expect(screen.getByTestId("historico-ficha")).toBeTruthy();
    expect(leitor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Consultar conversa/ }));
    await waitFor(() => expect(screen.getByText("pode me ligar?")).toBeTruthy());
    expect(leitor).toHaveBeenCalledTimes(1);
    expect(leitor).toHaveBeenCalledWith("A1", null);
  });

  it("mostra a data e a hora da consulta e de cada mensagem, sem apresentar como espelho", async () => {
    const leitor = vi.fn().mockResolvedValue(RESPOSTA);
    render(<HistoricoFichaAluno alunoId="A1" emailUsuario={PILOTO} leitor={leitor} />);
    fireEvent.click(screen.getByRole("button", { name: /Consultar conversa/ }));
    await waitFor(() => expect(screen.getByTestId("historico-ficha").textContent).toMatch(/Consultado na Mensageria em/));
    const texto = screen.getByTestId("historico-ficha").textContent;
    expect(texto).toMatch(/13\/11\/2026/);
    expect(texto).toMatch(/11\/11\/2026/);
    expect(texto).toMatch(/Não é um espelho salvo/);
  });

  it("recusa do servidor vira texto explicativo e não repete a consulta", async () => {
    const leitor = vi.fn().mockResolvedValue({ ok: false, motivo: "TETO_PILOTO_ESGOTADO", http: 200 });
    render(<HistoricoFichaAluno alunoId="A1" emailUsuario={PILOTO} leitor={leitor} />);
    fireEvent.click(screen.getByRole("button", { name: /Consultar conversa/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/limite de consultas do piloto/);
    expect(leitor).toHaveBeenCalledTimes(1);
  });

  it("429 aparece como parada, sem nova tentativa", async () => {
    const leitor = vi.fn().mockResolvedValue({ ok: false, motivo: "ULBRA_LIMITE", http: 200 });
    render(<HistoricoFichaAluno alunoId="A1" emailUsuario={PILOTO} leitor={leitor} />);
    fireEvent.click(screen.getByRole("button", { name: /Consultar conversa/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/429/);
    expect(leitor).toHaveBeenCalledTimes(1);
  });

  it("a lista de piloto vem vazia no código publicado", () => {
    expect(HISTORICO_FICHA_PILOTO_EMAILS).toEqual([]);
  });
});

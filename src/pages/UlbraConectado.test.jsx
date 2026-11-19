// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const concluir = vi.fn();
vi.mock("../utils/ulbraConversaCliente", () => ({ conexaoConcluir: (...a) => concluir(...a) }));
import UlbraConectado from "./UlbraConectado";

afterEach(cleanup);
beforeEach(() => concluir.mockReset());
const montar = (q) => render(<MemoryRouter initialEntries={[`/ulbra/conectado${q}`]}><UlbraConectado /></MemoryRouter>);

describe("retorno do OAuth", () => {
  it("entrega code e state à função e mostra quem conectou; nenhum token aparece na tela", async () => {
    concluir.mockResolvedValue({ ok: true, pessoa: "Maria Operadora" });
    montar("?code=abc&state=s1");
    expect(await screen.findByText(/Conectado como Maria Operadora/)).toBeTruthy();
    expect(concluir).toHaveBeenCalledWith("abc", "s1");
    expect(screen.getByTestId("ulbra-conectado").getAttribute("data-situacao")).toBe("ok");
  });
  it("erro da Mensageria ou retorno incompleto não chama a função", async () => {
    montar("?error=access_denied&state=s1");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(concluir).not.toHaveBeenCalled();
    cleanup();
    montar("?state=s1");
    expect((await screen.findByRole("alert")).textContent).toMatch(/sem código/);
  });
  it("state diferente (resposta da função) vira erro visível", async () => {
    concluir.mockResolvedValue({ ok: false, motivo: "STATE_DIFERENTE" });
    montar("?code=abc&state=outro");
    expect((await screen.findByRole("alert")).textContent).toMatch(/STATE_DIFERENTE/);
  });
});

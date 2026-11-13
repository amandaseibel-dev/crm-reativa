// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// O novo wrapper de MensalidadesSemNegociacao alterna entre 2026/1 e 2026/2.
const rpcMock = vi.fn(() => Promise.resolve({ data: null, error: null }));
vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (...a) => rpcMock(...a),
    auth: { getUser: async () => ({ data: { user: { email: "amanda.seibel@aelbra.com.br" } } }) },
  },
}));

vi.mock("./CarteiraEfetividade", () => ({
  default: ({ safraFixa }) => (
    <div data-testid="carteira-efetividade" data-safra-fixa={safraFixa}>
      CarteiraEfetividade (safraFixa={safraFixa})
    </div>
  ),
}));

import MensalidadesSemNegociacao from "./MensalidadesSemNegociacao";

describe("MensalidadesSemNegociacao", () => {
  beforeEach(() => {
    rpcMock.mockClear();
  });

  it("mostra seletor de semestre", () => {
    render(
      <MemoryRouter>
        <MensalidadesSemNegociacao />
      </MemoryRouter>
    );
    const groups = screen.getAllByRole("group");
    expect(groups.length).toBeGreaterThan(0);
  });

  it("abre em 2026/1 por padrao", () => {
    render(
      <MemoryRouter>
        <MensalidadesSemNegociacao />
      </MemoryRouter>
    );
    const groups = screen.getAllByRole("group");
    const botoes = groups[0].querySelectorAll("button");
    expect(botoes[0].getAttribute("aria-pressed")).toBe("true");
    expect(botoes[1].getAttribute("aria-pressed")).toBe("false");
  });

  it("alterna para 2026/2 ao clicar", () => {
    render(
      <MemoryRouter>
        <MensalidadesSemNegociacao />
      </MemoryRouter>
    );
    const groups = screen.getAllByRole("group");
    const botoes = groups[0].querySelectorAll("button");
    fireEvent.click(botoes[1]);
    expect(botoes[1].getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("carteira-efetividade")).toBeTruthy();
  });

  it("volta para 2026/1 ao clicar de novo", () => {
    render(
      <MemoryRouter>
        <MensalidadesSemNegociacao />
      </MemoryRouter>
    );
    const groups = screen.getAllByRole("group");
    const botoes = groups[0].querySelectorAll("button");
    fireEvent.click(botoes[1]);
    expect(screen.getByTestId("carteira-efetividade")).toBeTruthy();

    fireEvent.click(botoes[0]);
    expect(botoes[0].getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("carteira-efetividade")).toBeNull();
  });
});

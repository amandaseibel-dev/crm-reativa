// @vitest-environment jsdom
// B -- mural de elogios. A garantia de que campo sensivel nao sai do banco esta
// em supabase/tests/portal_mural_elogios.test.js; aqui se verifica a tela.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import MuralElogios, { SEM_ELOGIOS } from "./MuralElogios";
import { rotuloCurtidas, MODO_TOTAL, MODO_SEMANA } from "./curtidas";

afterEach(cleanup);

const EU = "cobranca05@aelbra.com.br";
const S = {};
const Card = ({ children }) => <div>{children}</div>;
const CabecalhoCard = ({ titulo }) => <strong>{titulo}</strong>;

const elogio = (id, texto, operador = "Mauricio", quando = "2026-09-20T12:00:00Z") =>
  ({ id, texto, operador_nome: operador, publicado_em: quando });

const comCurtidas = (pares = [], extra = {}) => ({
  disponivel: true, ocupado: null, mapa: new Map(pares),
  alternar: vi.fn(), recarregar: vi.fn(), ...extra,
});

const desenhar = (curtidas = undefined) =>
  act(async () => {
    render(<MuralElogios usuario={{ email: EU }} curtidas={curtidas} Card={Card} CabecalhoCard={CabecalhoCard} S={S} />);
  });

describe("rotulo de curtidas por modo", () => {
  it("o modo total não diz 'esta semana'", () => {
    expect(rotuloCurtidas(3, MODO_TOTAL)).toBe("3 curtidas");
    expect(rotuloCurtidas(1, MODO_TOTAL)).toBe("1 curtida");
    expect(rotuloCurtidas(0, MODO_TOTAL)).toBe("Nenhuma curtida");
    expect(rotuloCurtidas(3, MODO_SEMANA)).toBe("3 curtidas esta semana");
  });
});

describe("mural de elogios", () => {
  beforeEach(() => rpcMock.mockReset());

  it("mostra texto, operador e data de cada elogio", async () => {
    rpcMock.mockResolvedValue({
      data: [elogio("e1", "Excelente atendimento, resolveu tudo rapidamente.")], error: null,
    });
    await desenhar();

    expect(rpcMock).toHaveBeenCalledWith("portal_mural_elogios", { p_limite: 12 });
    expect(screen.getByText("Elogios da equipe")).toBeTruthy();
    expect(screen.getByText("Excelente atendimento, resolveu tudo rapidamente.")).toBeTruthy();
    expect(screen.getByText("Mauricio")).toBeTruthy();
    expect(screen.getByText("20/09/2026")).toBeTruthy();
  });

  it("mantém a ordem que o banco devolveu, sem reordenar por curtidas", async () => {
    rpcMock.mockResolvedValue({
      data: [
        elogio("e1", "Mais recente", "Olga", "2026-09-25T12:00:00Z"),
        elogio("e2", "Mais antigo", "João", "2026-09-10T12:00:00Z"),
      ],
      error: null,
    });
    // e2 tem MUITO mais curtidas, e mesmo assim continua embaixo:
    // reconhecimento, não competição.
    await desenhar(comCurtidas([["e1", { curtidas: 0, euCurti: false }], ["e2", { curtidas: 99, euCurti: false }]]));

    const textos = screen.getAllByText(/Mais (recente|antigo)/).map((n) => n.textContent);
    expect(textos).toEqual(["Mais recente", "Mais antigo"]);
  });

  it("curtir um elogio chama alternar com o id do elogio", async () => {
    rpcMock.mockResolvedValue({ data: [elogio("e1", "Muito atencioso")], error: null });
    const c = comCurtidas([["e1", { curtidas: 2, euCurti: false }]]);
    await desenhar(c);

    const botao = screen.getByRole("button", { name: /🤍 2/ });
    expect(botao.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { fireEvent.click(botao); });
    expect(c.alternar).toHaveBeenCalledWith("e1", EU);
  });

  it("coração cheio quando já curti", async () => {
    rpcMock.mockResolvedValue({ data: [elogio("e1", "Muito atencioso")], error: null });
    await desenhar(comCurtidas([["e1", { curtidas: 8, euCurti: true }]]));
    const b = screen.getByRole("button", { name: /❤️ 8/ });
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(b.title).toBe("Retirar minha curtida");
  });

  it("sem elogios publicados, mostra o estado vazio", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    await desenhar();
    expect(screen.getByText(SEM_ELOGIOS)).toBeTruthy();
  });

  it("some da Home quando a migration ainda não foi aplicada", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    const { container } = render(
      <MuralElogios usuario={{ email: EU }} Card={Card} CabecalhoCard={CabecalhoCard} S={S} />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("erro inesperado cai no estado vazio, sem derrubar a Home", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcMock.mockResolvedValue({ data: null, error: { code: "57014" } });
    await desenhar();
    expect(screen.getByText(SEM_ELOGIOS)).toBeTruthy();
    erro.mockRestore();
  });

  it("sem curtidas disponíveis, o mural segue legível e sem coração", async () => {
    rpcMock.mockResolvedValue({ data: [elogio("e1", "Atendimento nota 10")], error: null });
    await desenhar(comCurtidas([], { disponivel: false }));
    expect(screen.getByText("Atendimento nota 10")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

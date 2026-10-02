// @vitest-environment jsdom
// A2 -- faixa de destaque. A regra (janela da semana, desempate, so ativas) e do
// banco e esta coberta em supabase/tests/portal_curtidas_musica_da_semana.test.js.
// Aqui se verifica o que a tela faz com a resposta, inclusive quando a migration
// ainda nao foi aplicada.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import MusicaDaSemana, { SEM_VENCEDORA } from "./MusicaDaSemana";
import { rotuloCurtidas, estruturaAusente, indexarCurtidas, curtidasDe, alternarLocal, mensagemErroCurtida } from "./curtidas";

afterEach(cleanup);

const S = {};
const VENCEDORA = {
  id: "11111111-1111-4111-8111-111111111111",
  titulo: "Vou pra Santa Catarina", artista: "Terceira Dimensão",
  youtube_id: "AVSYcRdHpOA", adicionado_por: "Mauricio", curtidas: 4, semana: "2026-09-28",
};

const desenhar = () => act(async () => { render(<MusicaDaSemana S={S} />); });

describe("helpers de curtidas", () => {
  it("rotuloCurtidas cobre 0, 1 e muitas", () => {
    expect(rotuloCurtidas(0)).toBe("Nenhuma curtida esta semana");
    expect(rotuloCurtidas(1)).toBe("1 curtida esta semana");
    expect(rotuloCurtidas(7)).toBe("7 curtidas esta semana");
  });

  it("estruturaAusente reconhece tabela/funcao inexistente e ignora o resto", () => {
    for (const c of ["42P01", "42883", "PGRST202", "PGRST205"]) {
      expect(estruturaAusente({ code: c })).toBe(true);
    }
    expect(estruturaAusente({ code: "23505" })).toBe(false);
    expect(estruturaAusente(null)).toBe(false);
  });

  it("indexarCurtidas e curtidasDe devolvem contagem e se eu curti", () => {
    const m = indexarCurtidas([
      { alvo_id: "a", curtidas_semana: 3, eu_curti: true },
      { alvo_id: "b", curtidas_semana: 0, eu_curti: false },
    ]);
    expect(curtidasDe(m, "a")).toEqual({ curtidas: 3, euCurti: true });
    expect(curtidasDe(m, "b")).toEqual({ curtidas: 0, euCurti: false });
    expect(curtidasDe(m, "inexistente")).toEqual({ curtidas: 0, euCurti: false });
  });

  it("alternarLocal soma ao curtir e subtrai ao descurtir, sem ficar negativo", () => {
    let m = indexarCurtidas([{ alvo_id: "a", curtidas_semana: 2, eu_curti: false }]);
    m = alternarLocal(m, "a");
    expect(curtidasDe(m, "a")).toEqual({ curtidas: 3, euCurti: true });
    m = alternarLocal(m, "a");
    expect(curtidasDe(m, "a")).toEqual({ curtidas: 2, euCurti: false });
    expect(curtidasDe(alternarLocal(new Map(), "z"), "z")).toEqual({ curtidas: 1, euCurti: true });
  });

  it("mensagemErroCurtida traduz os codigos sem vazar SQL", () => {
    expect(mensagemErroCurtida({ code: "23505" })).toBe("Você já curtiu.");
    expect(mensagemErroCurtida({ code: "42501" })).toContain("permissão");
    expect(mensagemErroCurtida({ code: "42P01" })).toContain("ainda não estão ativadas");
    expect(mensagemErroCurtida(null)).toBeNull();
  });
});

describe("faixa da musica da semana", () => {
  beforeEach(() => rpcMock.mockReset());

  it("mostra capa, musica, artista, quem escolheu e a contagem", async () => {
    rpcMock.mockResolvedValue({ data: [VENCEDORA], error: null });
    await desenhar();

    expect(rpcMock).toHaveBeenCalledWith("portal_musica_da_semana");
    expect(screen.getByText("MÚSICA MAIS CURTIDA DA SEMANA")).toBeTruthy();
    expect(screen.getByText("Vou pra Santa Catarina")).toBeTruthy();
    expect(screen.getByText("Terceira Dimensão")).toBeTruthy();
    expect(screen.getByText("Escolhida por Mauricio")).toBeTruthy();
    expect(screen.getByText("❤️ 4")).toBeTruthy();
    expect(screen.getByText("4 curtidas esta semana")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://www.youtube.com/watch?v=AVSYcRdHpOA");
  });

  it("aceita a RPC devolvendo objeto em vez de lista", async () => {
    rpcMock.mockResolvedValue({ data: VENCEDORA, error: null });
    await desenhar();
    expect(screen.getByText("Vou pra Santa Catarina")).toBeTruthy();
  });

  it("sem curtidas na semana, mostra a frase combinada", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    await desenhar();
    expect(screen.getByText(new RegExp(SEM_VENCEDORA))).toBeTruthy();
    expect(screen.getByText(/Curta uma música da playlist/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("some da Home quando a migration ainda nao foi aplicada", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    const { container } = render(<MusicaDaSemana S={S} />);
    await act(async () => {});
    expect(container.querySelector("section")).toBeNull();
    expect(screen.queryByText("MÚSICA MAIS CURTIDA DA SEMANA")).toBeNull();
  });

  it("erro inesperado nao derruba a faixa: cai no estado vazio", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcMock.mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } });
    await desenhar();
    expect(screen.getByText(new RegExp(SEM_VENCEDORA))).toBeTruthy();
    erro.mockRestore();
  });
});

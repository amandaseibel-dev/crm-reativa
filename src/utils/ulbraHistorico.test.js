import { describe, it, expect } from "vitest";
import { HISTORICO_DISPONIVEL, podeVerHistorico } from "./ulbraHistorico";

describe("podeVerHistorico — visibilidade vem do servidor (capacidade_historico)", () => {
  it("sem capacidade do servidor, ninguém vê, nem a gestão nem o responsável", () => {
    expect(podeVerHistorico({ aluno_id: "al-1", minha: true }, true)).toBe(false);
    expect(podeVerHistorico({ aluno_id: "al-1", minha: true, capacidade_historico: false })).toBe(false);
    expect(podeVerHistorico(null)).toBe(false);
  });
  it("com capacidade concedida pelo servidor, a linha mostra o botão", () => {
    expect(podeVerHistorico({ aluno_id: "al-1", capacidade_historico: true })).toBe(true);
  });
  it("a porta nasce desligada: sem função publicada não há botão", () => {
    expect(HISTORICO_DISPONIVEL).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { HISTORICO_DISPONIVEL, podeVerHistorico } from "./ulbraHistorico";

describe("podeVerHistorico — só CPF confirmado e só quem a função aceita", () => {
  it("sem aluno_id (sem CPF confirmado) ninguém vê, nem a gestão", () => {
    expect(podeVerHistorico({ aluno_id: null, minha: true }, true)).toBe(false);
    expect(podeVerHistorico({ minha: true }, false)).toBe(false);
    expect(podeVerHistorico(null, true)).toBe(false);
  });
  it("operador vê só a linha de que é responsável (minha)", () => {
    expect(podeVerHistorico({ aluno_id: "al-1", minha: true }, false)).toBe(true);
    expect(podeVerHistorico({ aluno_id: "al-1", minha: false }, false)).toBe(false);
    expect(podeVerHistorico({ aluno_id: "al-1" }, false)).toBe(false);
  });
  it("gestão vê toda linha com CPF confirmado", () => {
    expect(podeVerHistorico({ aluno_id: "al-1", minha: false }, true)).toBe(true);
  });
  it("a porta nasce desligada: sem função publicada não há botão", () => {
    expect(HISTORICO_DISPONIVEL).toBe(false);
  });
});

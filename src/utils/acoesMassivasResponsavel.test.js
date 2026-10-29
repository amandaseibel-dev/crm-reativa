import { describe, it, expect } from "vitest";
import {
  detalheSelecao, responsaveisDaSelecao, sufixoArquivoResponsavel,
} from "./acoesMassivasResponsavel";

const nome = (e) => ({
  "cobranca03@teste.local": "Olga",
  "cobranca05@teste.local": "Luana",
  "carteira.geral@reativa.local": "Carteira Geral",
}[e] ?? e);

describe("desmontar a sintaxe do filtro", () => {
  it("só a dimensão de caso", () => {
    expect(responsaveisDaSelecao("CASO:a@x|b@x")).toEqual({ caso: ["a@x", "b@x"], acordo: [] });
  });

  it("as duas dimensões", () => {
    expect(responsaveisDaSelecao("CASO:a@x;ACORDO:c@x|SEM_RESPONSAVEL"))
      .toEqual({ caso: ["a@x"], acordo: ["c@x", "SEM_RESPONSAVEL"] });
  });

  it("o formato antigo não é confundido com seleção", () => {
    expect(responsaveisDaSelecao("cobranca03@teste.local")).toEqual({ caso: [], acordo: [] });
    expect(responsaveisDaSelecao("livres")).toEqual({ caso: [], acordo: [] });
    expect(responsaveisDaSelecao(null)).toEqual({ caso: [], acordo: [] });
  });
});

describe("nome de arquivo", () => {
  // ':' e '|' são inválidos em nome de arquivo em alguns sistemas — a sintaxe
  // crua nunca pode vazar para lá.
  it("um responsável vira o login", () => {
    expect(sufixoArquivoResponsavel("CASO:cobranca05@teste.local")).toBe("-cobranca05");
  });

  it("vários viram a contagem, sem ':' nem '|'", () => {
    const s = sufixoArquivoResponsavel("CASO:a@x|b@x|c@x");
    expect(s).toBe("-3responsaveis");
    expect(s).not.toMatch(/[:|]/);
  });

  it("a fila livre tem nome próprio", () => {
    expect(sufixoArquivoResponsavel("CASO:SEM_RESPONSAVEL")).toBe("-sem-responsavel");
  });

  it("formato antigo não gera sufixo", () => {
    expect(sufixoArquivoResponsavel("livres")).toBe("");
  });
});

describe("texto de tela", () => {
  it("nunca mostra a sintaxe crua", () => {
    const d = detalheSelecao("CASO:cobranca03@teste.local;ACORDO:cobranca05@teste.local", nome);
    expect(d.caso).toBe("Olga");
    expect(d.acordo).toBe("Luana");
    expect(`${d.caso}${d.acordo}`).not.toMatch(/CASO:|ACORDO:/);
  });

  it("dois nomes saem por extenso; três viram contagem", () => {
    expect(detalheSelecao("CASO:cobranca03@teste.local|cobranca05@teste.local", nome).caso)
      .toBe("Olga e Luana");
    expect(detalheSelecao("CASO:a@x|b@x|c@x", nome).caso).toBe("3 responsáveis");
  });

  it("sem dimensão de acordo, o campo fica vazio — a tela diz 'qualquer responsável'", () => {
    expect(detalheSelecao("CASO:cobranca03@teste.local", nome).acordo).toBe("");
  });

  it("a fila livre aparece por extenso", () => {
    expect(detalheSelecao("CASO:SEM_RESPONSAVEL", nome).caso).toBe("sem responsável / livres");
  });
});

// @vitest-environment jsdom
//
// QUEBRAS DE OBJEÇÃO NA TV + o giro das Dicas que nunca girou.
//
// Duas coisas são protegidas aqui:
//
//   1. a tela da TV mostra o MESMO conteúdo que o operador lê no Portal — a
//      fonte é um módulo só, importado pelos dois. Se alguém duplicar o texto,
//      o caso "a fonte é a mesma do Portal" quebra;
//   2. o rodízio anda. A tela de Dicas lia `snap.versao`, que NÃO existe no
//      payload (a versão é coluna da tabela e a TV guarda só `data.payload`):
//      o giro era sempre 0 e só as 3 primeiras dicas iam ao ar. Agora as duas
//      telas usam `indiceGiro`, que o orquestrador já passa.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CATALOGO_TELAS } from "./tvTelas";
import { OBJECOES } from "../../conteudo/objecoesNegociacao";
import { indiceDaObjecao } from "./tvRodizioObjecao";

afterEach(cleanup);

// Data FIXA em todo render: a objeção exibida depende do dia, e sem fixar a data
// a suíte passaria hoje e quebraria amanhã. As propriedades do rodízio em si
// (não repetir, cobrir tudo, mudar de dia) vivem em tvRodizioObjecao.test.js;
// aqui só se confere que a TELA obedece ao índice que o módulo devolve.
const DIA = new Date(2026, 9, 8);
const esperado = (g) => OBJECOES[indiceDaObjecao(g, OBJECOES.length, DIA)];

const tela = (id) => CATALOGO_TELAS.find((t) => t.id === id);
const desenhar = (id, props) => {
  const { Comp } = tela(id);
  return render(<Comp hoje={DIA} {...props} />);
};

describe("conteúdo compartilhado com o Portal", () => {
  it("são 35 objeções, todas com o que a TV precisa", () => {
    expect(OBJECOES).toHaveLength(35);
    expect(OBJECOES.every((o) => o.pergunta && o.principal)).toBe(true);
  });

  it("os campos opcionais seguem opcionais — a tela não pode assumir que existem", () => {
    expect(OBJECOES.filter((o) => o.alternativa)).toHaveLength(34);
    expect(OBJECOES.filter((o) => o.firme)).toHaveLength(3);
    expect(OBJECOES.some((o) => !o.alternativa)).toBe(true);
  });
});

describe("TV — Quebras de Objeção (catálogo)", () => {
  it("existe, está ligada e é do grupo de comunicação", () => {
    const t = tela("objecoes");
    expect(t).toBeTruthy();
    expect(t.nome).toBe("Quebras de Objeção");
    expect(t.ativa).toBe(true);
    expect(t.grupo).toBe("comunicacao");
  });

  it("não depende do snapshot: temConteudo libera sempre", () => {
    const { temConteudo } = tela("objecoes");
    expect(temConteudo({})).toBe(true);
    expect(temConteudo(null)).toBe(true);
  });

  it("a tela de Dicas continua existindo, separada", () => {
    expect(tela("dicas")).toBeTruthy();
    expect(tela("dicas").nome).toBe("Dicas de Abordagem");
  });
});

describe("TV — Quebras de Objeção (render)", () => {
  it("mostra a fala do aluno e a resposta principal", () => {
    desenhar("objecoes", { indiceGiro: 0 });
    expect(screen.getByText("O aluno diz")).toBeTruthy();
    expect(screen.getByText(`“${esperado(0).pergunta}”`)).toBeTruthy();
    expect(screen.getByText("Responda assim")).toBeTruthy();
    expect(screen.getByText(esperado(0).principal)).toBeTruthy();
  });

  it("uma objeção por volta — o giro anda e não repete", () => {
    const { unmount } = desenhar("objecoes", { indiceGiro: 0 });
    expect(screen.getByText(`“${esperado(0).pergunta}”`)).toBeTruthy();
    unmount();

    desenhar("objecoes", { indiceGiro: 1 });
    expect(screen.getByText(`“${esperado(1).pergunta}”`)).toBeTruthy();
    expect(screen.queryByText(`“${esperado(0).pergunta}”`)).toBeNull();
  });

  it("todas as 35 aparecem ao longo das voltas", () => {
    const vistas = new Set();
    for (let g = 0; g < OBJECOES.length; g++) {
      const { unmount } = desenhar("objecoes", { indiceGiro: g });
      vistas.add(screen.getByText(/^“.*”$/).textContent);
      unmount();
    }
    expect(vistas.size).toBe(35);
  });

  it("o giro dá a volta sem estourar a lista", () => {
    desenhar("objecoes", { indiceGiro: OBJECOES.length });
    expect(screen.getByText(`“${esperado(0).pergunta}”`)).toBeTruthy();
  });

  it("giro ausente ou inválido não quebra a tela", () => {
    for (const g of [undefined, null, NaN, -3, "x"]) {
      const { unmount } = desenhar("objecoes", { indiceGiro: g });
      expect(screen.getByText("Responda assim")).toBeTruthy();
      unmount();
    }
  });

  // O giro que cai numa objeção específica deixou de ser o índice dela: agora é
  // preciso PROCURAR a volta cujo índice bate. É isso que o rodízio faz.
  const giroQueMostra = (pred) => {
    for (let g = 0; g < OBJECOES.length; g++) if (pred(esperado(g))) return g;
    throw new Error("nenhuma volta mostra uma objeção com esse perfil");
  };

  it("mostra a resposta firme quando existe", () => {
    const g = giroQueMostra((o) => o.firme);
    desenhar("objecoes", { indiceGiro: g });
    expect(screen.getByText("Se insistir")).toBeTruthy();
    expect(screen.getByText(esperado(g).firme)).toBeTruthy();
  });

  it("sem resposta firme, cai na alternativa", () => {
    const g = giroQueMostra((o) => !o.firme && o.alternativa);
    desenhar("objecoes", { indiceGiro: g });
    expect(screen.getByText("Ou")).toBeTruthy();
    expect(screen.getByText(esperado(g).alternativa)).toBeTruthy();
    expect(screen.queryByText("Se insistir")).toBeNull();
  });

  it("objetivo e atenção ficam no Portal, não no telão", () => {
    desenhar("objecoes", { indiceGiro: 0 });
    expect(screen.queryByText(esperado(0).objetivo)).toBeNull();
    expect(screen.queryByText(esperado(0).atencao)).toBeNull();
  });

  it("diz em que ponto da lista está, seguindo o rodízio e não o giro", () => {
    const g = 4;
    const pos = indiceDaObjecao(g, OBJECOES.length, DIA);
    desenhar("objecoes", { indiceGiro: g });
    expect(screen.getByText(new RegExp(`Objeção ${pos + 1} de 35`))).toBeTruthy();
  });
});

describe("TV — Dicas: o giro que nunca girou", () => {
  const DICAS = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, ordem: i + 1, titulo: `Dica ${i + 1}`,
    categoria: "Sondagem", texto: `Texto da dica ${i + 1}`,
  }));

  it("na volta 0 mostra as três primeiras", () => {
    desenhar("dicas", { snap: { dicas: DICAS }, indiceGiro: 0 });
    expect(screen.getByText("Dica 1")).toBeTruthy();
    expect(screen.getByText("Dica 2")).toBeTruthy();
    expect(screen.queryByText("Dica 4")).toBeNull();
  });

  it("na volta seguinte anda — era aqui que travava", () => {
    desenhar("dicas", { snap: { dicas: DICAS }, indiceGiro: 1 });
    expect(screen.getByText("Dica 4")).toBeTruthy();
    expect(screen.queryByText("Dica 1")).toBeNull();
  });

  it("NÃO depende mais de snap.versao, que não existe no payload", () => {
    // Payload realista: tem `dicas`, não tem `versao`. Antes, isto prendia o
    // giro em 0 para sempre.
    desenhar("dicas", { snap: { dicas: DICAS }, indiceGiro: 2 });
    expect(screen.getByText("Dica 7")).toBeTruthy();
  });

  it("todas as 8 passam ao longo das voltas", () => {
    const vistas = new Set();
    for (let g = 0; g < 8; g++) {
      const { unmount } = desenhar("dicas", { snap: { dicas: DICAS }, indiceGiro: g });
      DICAS.forEach((d) => { if (screen.queryByText(d.titulo)) vistas.add(d.titulo); });
      unmount();
    }
    expect(vistas.size).toBe(8);
  });
});

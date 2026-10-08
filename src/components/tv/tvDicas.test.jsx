// @vitest-environment jsdom
//
// AS DICAS EXISTIAM E NUNCA APARECIAM.
//
// Relato da gestao (06/10/2026): "dicas e tal nao aparece". Medido no snapshot
// de producao (versao 511): a chave `dicas` vinha com 8 itens -- titulo, texto e
// categoria, em 4 categorias -- e NENHUMA tela da TV lia essa chave. Varredura
// em src/components/tv/: zero referencias a `dicas` antes desta mudanca.
//
// Nao e ajuste de calculo: o backend ja montava o dado. Faltava a tela.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CATALOGO_TELAS } from "./tvTelas";

afterEach(cleanup);

const DICAS = [
  { id: 1, ordem: 1, titulo: "Entenda a situação", categoria: "Sondagem",
    texto: '"O que fez a mensalidade ficar em aberto?" Ouça antes de oferecer.' },
  { id: 2, ordem: 2, titulo: "Pergunte o quanto cabe", categoria: "Negociação",
    texto: '"Hoje, quanto você consegue destinar?"' },
  { id: 3, ordem: 3, titulo: "Confirme o combinado", categoria: "Fechamento",
    texto: "Repita data e valor antes de encerrar." },
  { id: 4, ordem: 4, titulo: "Registre a tratativa", categoria: "Registro",
    texto: "O que não foi anotado não aconteceu." },
  { id: 5, ordem: 5, titulo: "Ofereça caminho", categoria: "Negociação", texto: "Duas opções, nunca uma." },
  { id: 6, ordem: 6, titulo: "Trate a objeção", categoria: "Negociação", texto: "Objeção é pedido de informação." },
  { id: 7, ordem: 7, titulo: "Combine o retorno", categoria: "Fechamento", texto: "Data e hora, não \"depois\"." },
  { id: 8, ordem: 8, titulo: "Agradeça sempre", categoria: "Registro", texto: "Encerre com o próximo passo claro." },
];

const tela = () => CATALOGO_TELAS.find((t) => t.id === "dicas");
const desenhar = (snap) => {
  const { Comp } = tela();
  return render(<Comp snap={snap} />);
};

describe("TV — tela de Dicas de Abordagem", () => {
  it("a tela existe, está ativa e entra no rodízio", () => {
    const t = tela();
    expect(t).toBeTruthy();
    expect(t.ativa).toBe(true);
    expect(t.nome).toBe("Dicas de Abordagem");
  });

  it("desenha as dicas que vêm do snapshot", () => {
    desenhar({ dicas: DICAS, versao: 0 });
    expect(screen.getByText("Entenda a situação")).toBeTruthy();
    expect(screen.getByText(/O que fez a mensalidade ficar em aberto/)).toBeTruthy();
    // a categoria vira o rotulo do destaque
    expect(screen.getByText("Sondagem")).toBeTruthy();
  });

  it("mostra três por vez e gira a cada atualização, para todas aparecerem", () => {
    // 8 dicas, 3 por vez: versao 0 -> itens 1-3; versao 1 -> itens 4-6. Sem
    // sobreposicao, entao todas passam pela TV em vez de so as tres primeiras.
    const { unmount } = desenhar({ dicas: DICAS, versao: 0 });
    expect(screen.getByText("Entenda a situação")).toBeTruthy();
    expect(screen.getByText("Pergunte o quanto cabe")).toBeTruthy();
    expect(screen.queryByText("Registre a tratativa")).toBeNull();
    unmount();

    desenhar({ dicas: DICAS, versao: 1 });
    expect(screen.getByText("Registre a tratativa")).toBeTruthy();
    expect(screen.getByText("Ofereça caminho")).toBeTruthy();
    expect(screen.queryByText("Entenda a situação")).toBeNull();
  });

  it("o giro nunca estoura a lista", () => {
    // versao alta e lista curta: ainda assim desenha sem quebrar
    expect(() => desenhar({ dicas: DICAS.slice(0, 2), versao: 999 })).not.toThrow();
  });

  it("sem dicas, diz que não há — não quebra nem some do rodízio", () => {
    desenhar({ dicas: [], versao: 3 });
    expect(screen.getByText(/Nenhuma dica cadastrada/)).toBeTruthy();
  });

  it("snapshot sem a chave `dicas` não derruba a tela", () => {
    expect(() => desenhar({ versao: 1 })).not.toThrow();
    expect(screen.getByText(/Nenhuma dica cadastrada/)).toBeTruthy();
  });

  it("`temConteudo` só libera a tela quando há dica", () => {
    const { temConteudo } = tela();
    expect(temConteudo({ dicas: DICAS })).toBe(true);
    expect(temConteudo({ dicas: [] })).toBe(false);
    expect(temConteudo({})).toBe(false);
  });

  it("nenhuma tela antiga saiu do rodízio", () => {
    const ids = CATALOGO_TELAS.map((t) => t.id);
    for (const antiga of [
      "hoje", "comparativo_ano", "resultado", "metas", "premiacao", "julho", "rankings",
      "aniversario_destaque", "aniversariantes", "magic_number", "destaque_semana",
      "acionamentos_dia", "elogios", "avisos", "playlist_reativa", "eventos_portal",
      "hall", "treinamento", "reconhecimento", "fechamento",
    ]) {
      expect(ids).toContain(antiga);
    }
    expect(ids).toContain("dicas");
    // 23 desde 08/10/2026: entrou "acordos_hoje".
    expect(ids).toContain("acordos_hoje");
    expect(ids.length).toBe(23);
  });
});

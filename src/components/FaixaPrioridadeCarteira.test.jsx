// @vitest-environment jsdom
//
// A faixa de prioridade da Minha Carteira: o que ela mostra e o que o clique
// faz. As contagens e o recorte sao testados em
// src/utils/carteiraFila.prioridade.test.js -- aqui e a tela.
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import FaixaPrioridadeCarteira from "./FaixaPrioridadeCarteira";

afterEach(cleanup);

const CONTAGENS = { TODOS: 48, PERDENDO: 12, CRITICO: 4, URGENTE: 9, ATENCAO: 15, NOVO: 3, NORMAL: 5 };

function Barra({ contagens = CONTAGENS, aoSelecionar }) {
  const [sel, setSel] = useState("TODAS");
  return (
    <FaixaPrioridadeCarteira
      contagens={contagens}
      selecionada={sel}
      onSelecionar={(f) => { setSel(f); if (aoSelecionar) aoSelecionar(f); }}
    />
  );
}

describe("FaixaPrioridadeCarteira", () => {
  it("mostra as seis faixas na ordem pedida, mais 'Todos'", () => {
    render(<Barra />);
    const rotulos = [...screen.getByTestId("faixa-prioridade").querySelectorAll("button")].map(
      (b) => b.textContent.replace(/\s+/g, " ").trim()
    );
    expect(rotulos).toEqual([
      "Todos 48",
      "Perdendo o caso 12",
      "Crítico 4",
      "Urgente 9",
      "Atenção 15",
      "Novo 3",
      "Normal 5",
    ]);
  });

  it("'Urgente' tem lugar proprio -- era a faixa sem nenhum recorte na tela", () => {
    render(<Barra />);
    expect(screen.getByTestId("chip-prioridade-URGENTE").textContent).toMatch(/Urgente\s*9/);
  });

  it("clicar numa faixa seleciona; clicar de novo volta para Todos", () => {
    const aoSelecionar = vi.fn();
    render(<Barra aoSelecionar={aoSelecionar} />);
    const chip = () => screen.getByTestId("chip-prioridade-CRITICO");

    expect(chip().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip());
    expect(aoSelecionar).toHaveBeenCalledWith("CRITICO");
    expect(chip().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("chip-prioridade-TODAS").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(chip());
    expect(aoSelecionar).toHaveBeenLastCalledWith("TODAS");
    expect(screen.getByTestId("chip-prioridade-TODAS").getAttribute("aria-pressed")).toBe("true");
  });

  it("'Todos' esta sempre disponivel para desfazer o recorte", () => {
    const aoSelecionar = vi.fn();
    render(<Barra aoSelecionar={aoSelecionar} />);
    fireEvent.click(screen.getByTestId("chip-prioridade-ATENCAO"));
    fireEvent.click(screen.getByTestId("chip-prioridade-TODAS"));
    expect(aoSelecionar).toHaveBeenLastCalledWith("TODAS");
  });

  it("faixa zerada continua visivel, com zero -- some da tela esconderia o recorte", () => {
    render(<Barra contagens={{ ...CONTAGENS, URGENTE: 0 }} />);
    expect(screen.getByTestId("chip-prioridade-URGENTE").textContent).toMatch(/Urgente\s*0/);
  });

  it("sem contagem nenhuma nao quebra nem inventa numero", () => {
    // Direto no componente: o harness acima tem contagem padrao.
    render(<FaixaPrioridadeCarteira contagens={undefined} onSelecionar={() => {}} />);
    expect(screen.getByTestId("chip-prioridade-TODAS").textContent).toMatch(/Todos\s*0/);
    expect(screen.getByTestId("chip-prioridade-PERDENDO").textContent).toMatch(/Perdendo o caso\s*0/);
  });

  it("o celular recebe regra propria (inline style nao faz media query)", () => {
    const { container } = render(<Barra />);
    const css = container.querySelector("style").textContent;
    expect(css).toMatch(/@media \(max-width: 640px\)/);
    expect(css).toMatch(/\.pc-prioridades \{ flex-wrap: nowrap !important;/);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import AvisoRetornoNaHora from "./AvisoRetornoNaHora";

afterEach(cleanup);
const retorno = { id: "a1", nome: "Aluna Um", telefone: "(51) 99999-0000", hora_retorno: "14:30", valor_em_aberto: 1200.5 };

describe("AvisoRetornoNaHora", () => {
  it("sem retorno nao aparece nada", () => {
    const { container } = render(<AvisoRetornoNaHora retorno={null} horaAgora="14:35" />);
    expect(container.firstChild).toBeNull();
  });

  it("mostra nome, telefone, valor, hora combinada e o atraso", () => {
    render(<AvisoRetornoNaHora retorno={retorno} horaAgora="14:42" />);
    const caixa = screen.getByTestId("aviso-retorno-na-hora");
    expect(caixa.textContent).toMatch(/Aluna Um/);
    expect(caixa.textContent).toMatch(/\(51\) 99999-0000/);
    expect(caixa.textContent).toMatch(/1\.200,50 em aberto/);
    expect(caixa.textContent).toMatch(/Combinado para as 14:30/);
    expect(caixa.textContent).toMatch(/há 12 min/);
  });

  it("na hora exata nao fala em atraso", () => {
    render(<AvisoRetornoNaHora retorno={retorno} horaAgora="14:30" />);
    expect(screen.getByTestId("aviso-retorno-na-hora").textContent).not.toMatch(/há .* min/);
  });

  it("aluno sem telefone diz isso em vez de deixar vazio", () => {
    render(<AvisoRetornoNaHora retorno={{ ...retorno, telefone: "" }} horaAgora="14:35" />);
    expect(screen.getByText("Sem telefone na ficha")).toBeTruthy();
  });

  it("o botao principal abre a ficha", () => {
    const abrir = vi.fn();
    render(<AvisoRetornoNaHora retorno={retorno} horaAgora="14:35" onAbrirFicha={abrir} />);
    fireEvent.click(screen.getByText("Abrir ficha e ligar"));
    expect(abrir).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });

  it("lembrar depois devolve os minutos combinados", () => {
    const depois = vi.fn();
    render(<AvisoRetornoNaHora retorno={retorno} horaAgora="14:35" minutosParaLembrar={10} onLembrarDepois={depois} />);
    fireEvent.click(screen.getByText("Lembrar em 10 min"));
    expect(depois).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), 10);
  });

  it("'já falei' marca o contato e o botao espera enquanto grava", () => {
    const feito = vi.fn();
    const { rerender } = render(<AvisoRetornoNaHora retorno={retorno} horaAgora="14:35" onMarcarFeito={feito} />);
    fireEvent.click(screen.getByText("✓ Já falei"));
    expect(feito).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
    rerender(<AvisoRetornoNaHora retorno={retorno} horaAgora="14:35" onMarcarFeito={feito} ocupado />);
    expect(screen.queryByText("✓ Já falei")).toBeNull();
  });

  it("é um diálogo de verdade, para leitor de tela e para o foco", () => {
    render(<AvisoRetornoNaHora retorno={retorno} horaAgora="14:35" />);
    const caixa = screen.getByRole("dialog", { name: "Hora do retorno" });
    expect(caixa.getAttribute("aria-modal")).toBe("true");
  });
});

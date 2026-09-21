// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import AlertasParcelaAcordo from "./AlertasParcelaAcordo";

afterEach(cleanup);
const A = (o) => ({ aluno_id: "a1", aluno_nome: "Aluna Teste", acordo_id: "c1", numero_acordo: 10, parcela_id: "p1", numero_parcela: 4, valor: 665.98, vencimento: "2026-10-19", dias_restantes: 2, data_alerta: "2026-10-17", responsavel_email: "cobranca06@aelbra.com.br", ...o });

describe("AlertasParcelaAcordo", () => {
  it("sem alertas nao renderiza nada", () => {
    const { container } = render(<AlertasParcelaAcordo alertas={[]} onAbrirFicha={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
  it("mostra aluno, acordo, parcela, valor, vencimento, dias restantes; responsavel so para a gestao; botao abre a ficha do aluno", () => {
    const abrir = vi.fn();
    render(<AlertasParcelaAcordo alertas={[A()]} onAbrirFicha={abrir} mostrarResponsavel />);
    expect(screen.getByText(/Parcela de acordo próxima do vencimento \(1\)/)).toBeTruthy();
    const item = screen.getByTestId("alerta-parcela-item");
    expect(item.textContent).toMatch(/Aluna Teste/);
    expect(item.textContent).toMatch(/Acordo #10 · parcela 4/);
    expect(item.textContent).toMatch(/665,98/);
    expect(item.textContent).toMatch(/19\/10\/2026/);
    expect(item.textContent).toMatch(/vence em 2 dias/);
    expect(item.textContent).toMatch(/cobranca06@aelbra.com.br/);
    fireEvent.click(screen.getByText("Abrir ficha"));
    expect(abrir).toHaveBeenCalledWith(expect.objectContaining({ aluno_id: "a1" }));
  });
  it("operador comum nao ve a linha de responsavel; dois acordos do mesmo aluno => duas linhas", () => {
    render(<AlertasParcelaAcordo alertas={[A(), A({ acordo_id: "c2", parcela_id: "p2", numero_acordo: 11 })]} onAbrirFicha={() => {}} />);
    expect(screen.getAllByTestId("alerta-parcela-item")).toHaveLength(2);
    expect(screen.queryByText(/responsável:/)).toBeNull();
  });
});

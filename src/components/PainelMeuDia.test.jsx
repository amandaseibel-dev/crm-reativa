// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import PainelMeuDia from "./PainelMeuDia";

afterEach(cleanup);

const HOJE = "2026-10-15";
const retorno = (o) => ({ id: "a1", aluno_id: "a1", nome: "Aluna Um", telefone: "51999990000", data: HOJE, hora_retorno: "14:30", valor_em_aberto: 1200.5, responsavel_email: "cobranca06@aelbra.com.br", tratado: false, ...o });
const boleto = (o) => ({ aluno_id: "b1", aluno_nome: "Fulana Dois", acordo_id: "c1", numero_acordo: 71903, parcela_id: "p1", numero_parcela: 3, valor: 665.98, vencimento: "2026-10-17", dias_restantes: 2, boleto: "571903000300", responsavel_email: "cobranca06@aelbra.com.br", tem_alerta: false, ...o });

describe("PainelMeuDia", () => {
  it("vazio continua na tela, dizendo que nao ha retorno nem boleto", () => {
    render(<PainelMeuDia hoje={HOJE} retornos={[]} boletos={[]} />);
    expect(screen.getByTestId("painel-meu-dia")).toBeTruthy();
    expect(screen.getByText(/Nenhum retorno agendado para hoje/)).toBeTruthy();
    expect(screen.getByText(/Nenhum boleto de acordo vencendo nesta janela/)).toBeTruthy();
  });

  it("abre em Hoje: o retorno de amanha nao aparece antes de pedir a semana", () => {
    render(<PainelMeuDia hoje={HOJE} retornos={[retorno(), retorno({ id: "a2", nome: "Aluna Dois", data: "2026-10-16" })]} boletos={[]} />);
    expect(screen.getAllByTestId("meu-dia-retorno-item")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Hoje (1)" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Semana (2)" }));
    fireEvent.click(screen.getAllByTestId("meu-dia-chip-dia")[1]);
    expect(screen.getByText("Aluna Dois")).toBeTruthy();
  });

  it("na semana os dias viram chips com o que falta em cada um, e a lista mostra o dia escolhido", () => {
    render(
      <PainelMeuDia
        hoje={HOJE}
        retornos={[
          retorno(),
          retorno({ id: "a2", nome: "Aluna Dois", data: "2026-10-16" }),
          retorno({ id: "a3", nome: "Aluna Tres", data: "2026-10-16", tratado: true }),
        ]}
        boletos={[]}
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: "Semana (2)" }));
    const chips = screen.getAllByTestId("meu-dia-chip-dia");
    expect(chips.map((c) => c.textContent)).toEqual(["Hoje · 1", "Amanhã · 1"]);
    // Abre no primeiro dia com retorno, sem empilhar a semana inteira.
    expect(chips[0].getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByTestId("meu-dia-retorno-item")).toHaveLength(1);
    expect(screen.getByText("Aluna Um")).toBeTruthy();

    fireEvent.click(chips[1]);
    expect(screen.getAllByTestId("meu-dia-retorno-item")).toHaveLength(2);
    expect(screen.getByText("Aluna Dois")).toBeTruthy();
    expect(screen.queryByText("Aluna Um")).toBeNull();
  });

  it("dia sem retorno nao vira chip", () => {
    render(<PainelMeuDia hoje={HOJE} retornos={[retorno({ data: "2026-10-18" })]} boletos={[]} />);
    fireEvent.click(screen.getByRole("tab", { name: "Semana (1)" }));
    expect(screen.getAllByTestId("meu-dia-chip-dia").map((c) => c.textContent)).toEqual(["dom 18/10 · 1"]);
  });

  it("mostra hora, telefone e valor do retorno e abre a ficha pelo nome", () => {
    const abrir = vi.fn();
    render(<PainelMeuDia hoje={HOJE} retornos={[retorno()]} boletos={[]} onAbrirFicha={abrir} />);
    const item = screen.getByTestId("meu-dia-retorno-item");
    expect(item.textContent).toMatch(/14:30/);
    expect(item.textContent).toMatch(/51999990000/);
    expect(item.textContent).toMatch(/1\.200,50/);
    fireEvent.click(screen.getByTitle("Abrir ficha do aluno"));
    expect(abrir).toHaveBeenCalledWith(expect.objectContaining({ aluno_id: "a1" }));
  });

  it("o check marca o contato como feito e, no que ja esta feito, desmarca", () => {
    const confirmar = vi.fn();
    render(<PainelMeuDia hoje={HOJE} retornos={[retorno(), retorno({ id: "a2", tratado: true })]} boletos={[]} onConfirmarRetorno={confirmar} />);
    fireEvent.click(screen.getByTitle("Marcar contato como feito"));
    expect(confirmar).toHaveBeenCalledWith("a1", true);
    fireEvent.click(screen.getByTitle("Contato feito — clique para desmarcar"));
    expect(confirmar).toHaveBeenCalledWith("a2", false);
    // O contador do dia conta so o que falta fazer.
    expect(screen.getByRole("tab", { name: "Hoje (1)" })).toBeTruthy();
  });

  it("contador do prazo automatico aparece separado e abre a fila filtrada", () => {
    const verFila = vi.fn();
    render(<PainelMeuDia hoje={HOJE} retornos={[retorno()]} retornoAutomaticoHoje={405} boletos={[]} onVerRetornosNaFila={verFila} />);
    expect(screen.getByTestId("meu-dia-retorno-automatico").textContent).toMatch(/\+405 com prazo de tabulação vencendo hoje/);
    fireEvent.click(screen.getByText("ver na fila"));
    expect(verFila).toHaveBeenCalled();
  });

  it("sem prazo automatico o contador nao aparece", () => {
    render(<PainelMeuDia hoje={HOJE} retornos={[retorno()]} retornoAutomaticoHoje={0} boletos={[]} />);
    expect(screen.queryByTestId("meu-dia-retorno-automatico")).toBeNull();
  });

  it("boleto mostra vencimento, valor, parcela, acordo, numero do boleto e prazo", () => {
    render(<PainelMeuDia hoje={HOJE} retornos={[]} boletos={[boleto()]} />);
    const item = screen.getByTestId("meu-dia-boleto-item");
    expect(item.textContent).toMatch(/17\/10\/2026/);
    expect(item.textContent).toMatch(/665,98/);
    expect(item.textContent).toMatch(/parc\. 3 do acordo #71903/);
    expect(item.textContent).toMatch(/boleto 571903000300/);
    expect(item.textContent).toMatch(/vence em 2 dias/);
    expect(screen.getByText(/Parcela de acordo ativo até 20\/10\/2026/)).toBeTruthy();
  });

  it("quem vence hoje ganha destaque e o alerta D-2 aberto fica marcado", () => {
    render(<PainelMeuDia hoje={HOJE} retornos={[]} boletos={[boleto({ dias_restantes: 0, vencimento: HOJE }), boleto({ parcela_id: "p2", tem_alerta: true })]} />);
    expect(screen.getByText("1 vence(m) hoje")).toBeTruthy();
    expect(screen.getByText("vence hoje")).toBeTruthy();
    expect(screen.getByText("🔔")).toBeTruthy();
  });

  it("responsavel so aparece na visao da gestao", () => {
    const { unmount } = render(<PainelMeuDia hoje={HOJE} retornos={[retorno()]} boletos={[boleto()]} />);
    expect(screen.queryByText(/cobranca06@aelbra.com.br/)).toBeNull();
    unmount();
    render(<PainelMeuDia hoje={HOJE} retornos={[retorno()]} boletos={[boleto()]} mostrarResponsavel />);
    expect(screen.getAllByText(/cobranca06@aelbra.com.br/).length).toBe(2);
  });

  it("a pagina nao cresce com a lista: 5 linhas por coluna, o resto atras de 'ver todos'", () => {
    const muitos = Array.from({ length: 9 }, (_, i) => boleto({ parcela_id: `p${i}`, numero_parcela: i + 1 }));
    render(<PainelMeuDia hoje={HOJE} retornos={Array.from({ length: 8 }, (_, i) => retorno({ id: `a${i}` }))} boletos={muitos} />);
    expect(screen.getAllByTestId("meu-dia-retorno-item")).toHaveLength(5);
    expect(screen.getAllByTestId("meu-dia-boleto-item")).toHaveLength(5);
    fireEvent.click(screen.getByText("Ver todos (9)"));
    expect(screen.getAllByTestId("meu-dia-boleto-item")).toHaveLength(9);
    fireEvent.click(screen.getByText("Ver todos (8)"));
    expect(screen.getAllByTestId("meu-dia-retorno-item")).toHaveLength(8);
  });
});

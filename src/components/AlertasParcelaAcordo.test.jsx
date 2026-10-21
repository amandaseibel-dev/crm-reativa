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
    expect(item.textContent).toMatch(/vence em 2 dias/);
    // A data completa saiu do texto corrido e virou `title` da coluna de
    // vencimento: a linha mostra "vence em 2 dias" (regra 4 -- vencimento OU
    // dias de atraso), e a data exata continua a um passar de mouse.
    expect(item.querySelector('[title="vencimento 19/10/2026"]')).toBeTruthy();
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

// Compactacao de 21/10/2026. A M2 passou a devolver tambem as parcelas VENCIDAS
// de ate 30 dias: ~144 por operador, contra 23 em toda a base antes dela. O card
// abria todas de uma vez e a tela do operador ficava longa demais.
describe("AlertasParcelaAcordo: resumo compacto e expansao", () => {
  const muitos = (n) =>
    Array.from({ length: n }, (_, i) =>
      A({ aluno_id: `a${i}`, aluno_nome: `Aluno ${i}`, acordo_id: `c${i}`, parcela_id: `p${i}`, valor: 100 + i, dias_restantes: -(i + 1) }));

  it("sem `limite` mantem o comportamento antigo: lista inteira, sem botao", () => {
    render(<AlertasParcelaAcordo alertas={muitos(12)} onAbrirFicha={() => {}} />);
    expect(screen.getAllByTestId("alerta-parcela-item")).toHaveLength(12);
    expect(screen.queryByTestId("alertas-parcela-expandir")).toBeNull();
  });

  it("com `limite` mostra so as mais urgentes, e o cabecalho continua dizendo QUANTAS sao", () => {
    render(<AlertasParcelaAcordo alertas={muitos(143)} onAbrirFicha={() => {}} limite={5} />);
    expect(screen.getAllByTestId("alerta-parcela-item")).toHaveLength(5);
    // A contagem total nao some: ela e o que diz ao operador o tamanho da fila.
    expect(screen.getByText(/\(143\)/)).toBeTruthy();
    expect(screen.getByTestId("alertas-parcela-expandir").textContent).toMatch(/138 a mais/);
  });

  it("o cabecalho soma o valor de TODAS, nao so das visiveis", () => {
    // 3 alertas de 100, 101 e 102 => 303, mesmo mostrando uma so.
    render(<AlertasParcelaAcordo alertas={muitos(3)} onAbrirFicha={() => {}} limite={1} />);
    expect(screen.getAllByTestId("alerta-parcela-item")).toHaveLength(1);
    expect(screen.getByTestId("alertas-parcela-total").textContent).toMatch(/303,00/);
  });

  it("expandir mostra todas e o botao vira Recolher; recolher volta ao compacto", () => {
    render(<AlertasParcelaAcordo alertas={muitos(20)} onAbrirFicha={() => {}} limite={5} />);
    const botao = screen.getByTestId("alertas-parcela-expandir");
    expect(botao.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(botao);
    expect(screen.getAllByTestId("alerta-parcela-item")).toHaveLength(20);
    expect(botao.getAttribute("aria-expanded")).toBe("true");
    expect(botao.textContent).toMatch(/Recolher/);
    fireEvent.click(botao);
    expect(screen.getAllByTestId("alerta-parcela-item")).toHaveLength(5);
  });

  it("limite maior que a lista nao mostra botao nenhum", () => {
    render(<AlertasParcelaAcordo alertas={muitos(3)} onAbrirFicha={() => {}} limite={5} />);
    expect(screen.getAllByTestId("alerta-parcela-item")).toHaveLength(3);
    expect(screen.queryByTestId("alertas-parcela-expandir")).toBeNull();
  });

  it("o recorte compacto mostra as MAIS URGENTES: a ordem continua por dias_restantes", () => {
    const fora = A({ aluno_id: "z", aluno_nome: "Mais urgente", acordo_id: "cz", parcela_id: "pz", dias_restantes: -99 });
    render(<AlertasParcelaAcordo alertas={[...muitos(10), fora]} onAbrirFicha={() => {}} limite={2} />);
    const itens = screen.getAllByTestId("alerta-parcela-item");
    expect(itens).toHaveLength(2);
    expect(itens[0].textContent).toMatch(/Mais urgente/);
  });

  it("abrir a ficha continua funcionando a partir do recorte compacto", () => {
    const abrir = vi.fn();
    render(<AlertasParcelaAcordo alertas={muitos(30)} onAbrirFicha={abrir} limite={3} />);
    fireEvent.click(screen.getAllByText("Abrir ficha")[0]);
    expect(abrir).toHaveBeenCalledWith(expect.objectContaining({ aluno_id: expect.any(String) }));
  });
});

// Situacao de acionamento na linha (21/10/2026). O rotulo fala do ALUNO: nao ha
// registro que ligue contato a parcela.
describe("AlertasParcelaAcordo: situacao do acionamento", () => {
  const HOJE = "2026-10-21";
  const venc = (o) => A({ vencimento: "2026-10-15", dias_restantes: -6, ...o });

  it("mostra o selo com o texto da situacao", () => {
    const idx = new Map([["a1", { dua: "2026-10-18", temCaso: true }]]);
    render(<AlertasParcelaAcordo alertas={[venc()]} onAbrirFicha={() => {}} acionamentoPorAluno={idx} hoje={HOJE} />);
    expect(screen.getByTestId("alerta-parcela-acionamento").textContent).toBe("Acionado há 3 dias · após o vencimento");
  });

  it("aluno sem caso na fila recebe a indicacao NEUTRA, nao um palpite", () => {
    render(<AlertasParcelaAcordo alertas={[venc()]} onAbrirFicha={() => {}} acionamentoPorAluno={new Map()} hoje={HOJE} />);
    const t = screen.getByTestId("alerta-parcela-acionamento").textContent;
    expect(t).toBe("Sem aviso específico identificado");
    expect(t).not.toMatch(/Acionado/);
  });

  it("caso sem data => Nao acionado", () => {
    const idx = new Map([["a1", { dua: null, temCaso: true }]]);
    render(<AlertasParcelaAcordo alertas={[venc()]} onAbrirFicha={() => {}} acionamentoPorAluno={idx} hoje={HOJE} />);
    expect(screen.getByTestId("alerta-parcela-acionamento").textContent).toBe("Não acionado");
  });

  it("sem o indice, a linha NAO inventa selo nenhum", () => {
    render(<AlertasParcelaAcordo alertas={[venc()]} onAbrirFicha={() => {}} hoje={HOJE} />);
    expect(screen.queryByTestId("alerta-parcela-acionamento")).toBeNull();
  });

  it("no recorte compacto, quem nao tem aviso comprovado aparece primeiro", () => {
    const alertas = [
      venc({ aluno_id: "ok", aluno_nome: "Ja acionado depois", acordo_id: "c1", parcela_id: "p1" }),
      venc({ aluno_id: "nunca", aluno_nome: "Nunca acionado", acordo_id: "c2", parcela_id: "p2" }),
    ];
    const idx = new Map([
      ["ok", { dua: "2026-10-18", temCaso: true }],
      ["nunca", { dua: null, temCaso: true }],
    ]);
    render(<AlertasParcelaAcordo alertas={alertas} onAbrirFicha={() => {}} acionamentoPorAluno={idx} hoje={HOJE} limite={1} />);
    const itens = screen.getAllByTestId("alerta-parcela-item");
    expect(itens).toHaveLength(1);
    expect(itens[0].textContent).toMatch(/Nunca acionado/);
  });

  it("a linha mostra os quatro dados da regra: nome, atraso, valor e situacao", () => {
    const idx = new Map([["a1", { dua: "2026-10-18", temCaso: true }]]);
    render(<AlertasParcelaAcordo alertas={[venc()]} onAbrirFicha={() => {}} acionamentoPorAluno={idx} hoje={HOJE} />);
    const t = screen.getByTestId("alerta-parcela-item").textContent;
    expect(t).toMatch(/Aluna Teste/);
    expect(t).toMatch(/6 dias de atraso/);
    expect(t).toMatch(/665,98/);
    expect(t).toMatch(/Acionado há 3 dias · após o vencimento/);
  });
});

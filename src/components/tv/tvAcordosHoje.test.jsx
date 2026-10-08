// @vitest-environment jsdom
//
// ACORDOS DE HOJE — a tela só repete o que o snapshot calculou.
//
// As duas definições vivem na migration 20261008120000 e foram medidas em
// produção antes de existir código. O que estes casos protegem é que a TELA não
// invente nenhuma delas: nem a taxa, nem o "ainda sem pagamento", nem o que
// fazer quando o dia começou e não há acordo.
//
// Os fixtures usam valores em que recalcular daria OUTRO resultado, então
// qualquer conta que nasça aqui quebra a suíte.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CATALOGO_TELAS } from "./tvTelas";

afterEach(cleanup);

const tela = () => CATALOGO_TELAS.find((t) => t.id === "acordos_hoje");
const desenhar = (snap) => {
  const { Comp } = tela();
  return render(<Comp snap={snap} />);
};

// Formato exato que tv_snapshot_atualizar entrega.
const DIA = (extra = {}) => ({
  acordos_hoje: {
    data: "2026-10-08",
    fechados: 12, convertidos: 5, valor_pago: 8430, taxa_pct: 41.7,
    ranking: [
      // Números escolhidos para NÃO colidirem com 12 / 5 / 7 do cabeçalho:
      // assim cada asserção abaixo aponta para um elemento só.
      { operador: "Allan", fechados: 6, convertidos: 3, valor_pago: 3100 },
      { operador: "Rafaella", fechados: 4, convertidos: 2, valor_pago: 2900 },
      { operador: "Nataly", fechados: 2, convertidos: 1, valor_pago: 1430 },
      { operador: "Mauricio", fechados: 1, convertidos: 0, valor_pago: 0 },
    ],
    ...extra,
  },
});

describe("TV — Acordos de Hoje (catálogo)", () => {
  it("existe, está ligada e é de operação", () => {
    const t = tela();
    expect(t).toBeTruthy();
    expect(t.nome).toBe("Acordos de Hoje");
    expect(t.ativa).toBe(true);
    expect(t.grupo).toBe("operacao");
  });

  it("fica visível mesmo sem acordo — dia zerado é informação", () => {
    const { temConteudo } = tela();
    expect(temConteudo({})).toBe(true);
    expect(temConteudo({ acordos_hoje: { fechados: 0 } })).toBe(true);
    expect(temConteudo(null)).toBe(true);
  });
});

describe("TV — Acordos de Hoje (render)", () => {
  it("mostra fechados, convertidos, valor e o que falta", () => {
    desenhar(DIA());
    expect(screen.getByText("Acordos fechados hoje")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("Já com pagamento")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("Valor pago")).toBeTruthy();
    expect(screen.getByText("R$ 8.430")).toBeTruthy();
    expect(screen.getByText("Ainda sem pagamento")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy(); // 12 - 5
  });

  it("a taxa é a do snapshot — a tela não divide convertidos por fechados", () => {
    // 5/12 = 41,7%. O fixture manda 60 de propósito: se recalculasse, daria 42.
    desenhar(DIA({ taxa_pct: 60 }));
    expect(screen.getByText("60%")).toBeTruthy();
    expect(screen.queryByText("42%")).toBeNull();
    expect(screen.getByText(/já pagaram/i)).toBeTruthy();
  });

  it("o ranking vem do snapshot, com os três números por operador", () => {
    desenhar(DIA());
    expect(screen.getByText("Allan")).toBeTruthy();
    expect(screen.getByText("Rafaella")).toBeTruthy();
    expect(screen.getByText("R$ 3.100")).toBeTruthy();
    expect(screen.getAllByText("fechados").length).toBeGreaterThan(0);
    expect(screen.getAllByText("pagos").length).toBeGreaterThan(0);
  });

  it("mostra no máximo 4 operadores, para caber de longe", () => {
    const muitos = Array.from({ length: 8 }, (_, i) => ({
      operador: `Op${i}`, fechados: 8 - i, convertidos: 1, valor_pago: 100,
    }));
    desenhar(DIA({ ranking: muitos }));
    expect(screen.getByText("Op0")).toBeTruthy();
    expect(screen.getByText("Op3")).toBeTruthy();
    expect(screen.queryByText("Op4")).toBeNull();
  });
});

describe("TV — Acordos de Hoje (o dia que ainda não começou)", () => {
  it("sem acordo nenhum, convida em vez de mostrar 0%", () => {
    desenhar({ acordos_hoje: { data: "2026-10-08", fechados: 0, convertidos: 0, valor_pago: 0, taxa_pct: null, ranking: [] } });
    expect(screen.getByText(/Nenhum acordo fechado hoje ainda/)).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.queryByText("Acordos fechados hoje")).toBeNull();
  });

  it("snapshot sem a chave não derruba a tela", () => {
    expect(() => desenhar({})).not.toThrow();
    expect(screen.getByText(/Nenhum acordo fechado hoje ainda/)).toBeTruthy();
  });

  it("taxa nula com acordos fechados não vira 0% enganoso", () => {
    desenhar(DIA({ taxa_pct: null, convertidos: 0, valor_pago: 0 }));
    expect(screen.getByText("—")).toBeTruthy();
  });
});

describe("TV — Acordos de Hoje (bordas)", () => {
  it("todos convertidos: o card do que falta vai a zero", () => {
    // Sem ranking para a asserção do zero apontar um elemento só.
    desenhar(DIA({ fechados: 4, convertidos: 4, taxa_pct: 100, ranking: [] }));
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getAllByText("4")).toHaveLength(2);  // fechados e convertidos
    expect(screen.getByText("0")).toBeTruthy();        // ainda sem pagamento
  });

  it("ranking ausente não quebra a tela", () => {
    expect(() => desenhar(DIA({ ranking: undefined }))).not.toThrow();
    expect(screen.getByText("Acordos fechados hoje")).toBeTruthy();
  });

  it("operador sem conversão aparece com zero, não some", () => {
    desenhar(DIA());
    expect(screen.getByText("Mauricio")).toBeTruthy();
    expect(screen.getByText("R$ 0")).toBeTruthy();  // valor dele, só ele tem zero
  });
});

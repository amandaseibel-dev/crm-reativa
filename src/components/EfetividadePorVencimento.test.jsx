// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, within } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import EfetividadePorVencimento from "./EfetividadePorVencimento";

// Amostra deliberada: um mês com CADA caso que a gestão pediu para conferir —
// pagamento parcial, acordo ativo, acordo cancelado, título cancelado e item em
// conferência — e um mês só com pendência, que é onde o "0 aluno" aparece.
const PAYLOAD = {
  gerado_em: "2026-09-29T16:45:20Z",
  semestre: "2026/2",
  saldo_metodo: "Saldo do classificador 2026/2: Pago = valor recebido.",
  atualizado_em: { prime_coletado_em: "2026-09-27", titulo_mexido_em: "2026-09-29" },
  conferencia: { meses_que_nao_fecham: 0, diferenca_total: 0 },
  pago_composicao: { atribuido: 80, rateado: 20 },
  total: {
    vencimento_de: "2026-07-01", vencimento_ate: "2026-08-10",
    fichas: 4, cpfs: 3,
    situacoes: {
      entrou:    { alunos: 4, titulos: 5, valor: 1000 },
      pago:      { alunos: 1, titulos: 1, valor: 100 },
      negociado: { alunos: 1, titulos: 1, valor: 200 },
      cancelado: { alunos: 1, titulos: 1, valor: 300 },
      em_aberto: { alunos: 2, titulos: 2, valor: 250 },
      pendente:  { alunos: 1, titulos: 1, valor: 150 },
    },
  },
  meses: [
    {
      competencia: "2026-07-01", vencimento_de: "2026-07-01", vencimento_ate: "2026-07-30",
      datas_de_vencimento: 19,
      pago_composicao: { atribuido: 80, rateado: 20 },
      situacoes: {
        entrou:    { alunos: 4, titulos: 5, valor: 1000 },
        pago:      { alunos: 1, titulos: 1, valor: 100 },
        negociado: { alunos: 1, titulos: 1, valor: 200 },
        cancelado: { alunos: 1, titulos: 1, valor: 300 },
        em_aberto: { alunos: 2, titulos: 2, valor: 250 },
        pendente:  { alunos: 1, titulos: 1, valor: 150 },
      },
      status: [
        { status: "Cobrança cancelada", alunos: 1, titulos: 1, valor: 300 },
        { status: "Pago / Quitado", alunos: 1, titulos: 1, valor: 200 },
        { status: "Negociado regular", alunos: 1, titulos: 1, valor: 200 },
        { status: "Acordo cancelado", alunos: 1, titulos: 1, valor: 150 },
        { status: "Liquidado no Prime, origem não comprovada", alunos: 1, titulos: 1, valor: 150 },
      ],
    },
    {
      competencia: "2026-08-01", vencimento_de: "2026-08-05", vencimento_ate: "2026-08-05",
      datas_de_vencimento: 1,
      situacoes: {
        entrou:   { alunos: 1, titulos: 1, valor: 500 },
        pendente: { alunos: 1, titulos: 1, valor: 500 },
      },
      status: [{ status: "Baixa / ajuste acadêmico", alunos: 1, titulos: 1, valor: 500 }],
    },
  ],
};

function comPayload(troca = {}) {
  return { ...structuredClone(PAYLOAD), ...troca };
}

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation(async () => ({ data: comPayload(), error: null }));
});
afterEach(cleanup);

async function montar() {
  await act(async () => { render(<EfetividadePorVencimento />); });
}

function cartao(nome) {
  return screen.getByText(nome).closest("div").parentElement;
}

describe("Efetividade por mês de vencimento", () => {
  it("chama a RPC de agregação, e não o classificador direto", async () => {
    await montar();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("carteira_2026_2_por_vencimento");
  });

  it("desenha um cartão por mês de vencimento, mais o consolidado", async () => {
    await montar();
    expect(screen.getByText("Julho de 2026")).toBeTruthy();
    expect(screen.getByText("Agosto de 2026")).toBeTruthy();
    expect(screen.getByText("Todos os meses")).toBeTruthy();
    // ENTROU aparece uma vez por cartão: 2 meses + 1 consolidado.
    expect(screen.getAllByText("Entrou")).toHaveLength(3);
  });

  it("mostra as cinco situações e a pendência separada, em cada cartão", async () => {
    await montar();
    const julho = cartao("Julho de 2026");
    for (const r of ["Pago", "Negociado", "Cancelado", "Em aberto", "Pendente de classificação"]) {
      expect(within(julho).getByText(r)).toBeTruthy();
    }
  });

  it("um mês sem pagamento nem acordo mostra as situações zeradas, não some com elas", async () => {
    await montar();
    const agosto = cartao("Agosto de 2026");
    // Sumir com a linha faria a leitura errada de "não foi medido". Zero é
    // resultado, e resultado aparece.
    expect(within(agosto).getByText("Pago")).toBeTruthy();
    expect(within(agosto).getAllByText("R$ 0,00").length).toBeGreaterThanOrEqual(4);
  });

  it("título cancelado conta em Cancelado; acordo cancelado não vira título cancelado", async () => {
    await montar();
    const julho = cartao("Julho de 2026");
    // Cancelado = R$ 300, que é só o título com a COBRANÇA cancelada. O título
    // de acordo cancelado (R$ 150 no status) não está aqui — o saldo dele é
    // cobrável e por isso mora em Em aberto.
    expect(within(julho).getByText("R$ 300,00")).toBeTruthy();
    expect(within(julho).getByText("Acordo cancelado")).toBeTruthy();
    expect(within(julho).getByText("Cobrança cancelada")).toBeTruthy();
  });

  it("lista alunos por status abaixo dos números", async () => {
    await montar();
    const julho = cartao("Julho de 2026");
    expect(within(julho).getByText("Alunos por status")).toBeTruthy();
    expect(within(julho).getByText("Liquidado no Prime, origem não comprovada")).toBeTruthy();
  });

  it("avisa que contagem de aluno não soma", async () => {
    await montar();
    expect(screen.getByText(/não devem ser somadas/)).toBeTruthy();
  });

  it("identifica de qual saldo os números vieram", async () => {
    await montar();
    expect(screen.getByText(/Pago = valor recebido/)).toBeTruthy();
  });

  it("singular quando é um só", async () => {
    await montar();
    // "1 aluno · 1 título", nunca "1 alunos · 1 títulos".
    expect(screen.queryByText(/\b1 alunos\b/)).toBeNull();
    expect(screen.queryByText(/\b1 títulos\b/)).toBeNull();
  });

  it("quando a invariante não fecha, avisa e NÃO ajusta número nenhum", async () => {
    rpcMock.mockImplementation(async () => ({
      data: comPayload({ conferencia: { meses_que_nao_fecham: 1, diferenca_total: 12.34 } }),
      error: null,
    }));
    await montar();
    expect(screen.getByText(/mês não fecha/)).toBeTruthy();
    expect(screen.getByText(/R\$ 12,34/)).toBeTruthy();
    // Os valores seguem os que vieram da RPC.
    expect(within(cartao("Julho de 2026")).getByText("R$ 1.000,00")).toBeTruthy();
  });

  it("não chama o Pago de valor efetivamente recebido", async () => {
    await montar();
    // O Pago de um mês inclui rateio de acordo; prometer atribuição exata seria
    // afirmar mais do que a fonte sustenta.
    expect(screen.queryByText(/efetivamente recebido/)).toBeNull();
  });

  it("Pago tem um total só, com a composição dentro da própria linha", async () => {
    await montar();
    const julho = cartao("Julho de 2026");
    // Um total principal...
    expect(within(julho).getByText("R$ 100,00")).toBeTruthy();
    // ...e a composição embaixo dele, nunca como segunda métrica ao lado.
    expect(within(julho).getByText(/Atribuído diretamente/)).toBeTruthy();
    expect(within(julho).getByText(/Por rateio/)).toBeTruthy();
    expect(within(julho).getByText("R$ 80,00")).toBeTruthy();
    expect(within(julho).getByText("R$ 20,00")).toBeTruthy();
  });

  it("a composição do Pago fecha com o total do Pago", async () => {
    const d = comPayload();
    for (const m of d.meses) {
      if (!m.pago_composicao) continue;
      const soma = m.pago_composicao.atribuido + m.pago_composicao.rateado;
      expect(soma).toBe(m.situacoes.pago.valor);
    }
    const t = d.pago_composicao;
    expect(t.atribuido + t.rateado).toBe(d.total.situacoes.pago.valor);
  });

  it("mês sem pagamento não mostra composição de Pago", async () => {
    await montar();
    const agosto = cartao("Agosto de 2026");
    expect(within(agosto).queryByText(/Atribuído diretamente/)).toBeNull();
  });

  it("diz na tela que os cartões contam ficha e a linha de cima conta CPF", async () => {
    await montar();
    expect(screen.getByText(/Duas unidades de contagem/)).toBeTruthy();
    expect(screen.getByText(/fichas do CRM/)).toBeTruthy();
  });

  it("quando ficha e CPF coincidem, não polui a tela com a ressalva", async () => {
    rpcMock.mockImplementation(async () => {
      const d = comPayload();
      d.total.cpfs = d.total.fichas;
      return { data: d, error: null };
    });
    await montar();
    expect(screen.queryByText(/Duas unidades de contagem/)).toBeNull();
  });

  it("erro da RPC não derruba a tela", async () => {
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: "Acesso negado." } }));
    await montar();
    expect(screen.getByText(/Acesso negado/)).toBeTruthy();
  });
});

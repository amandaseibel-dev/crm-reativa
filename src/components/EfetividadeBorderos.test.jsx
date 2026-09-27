// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";

// O que se prova aqui é o ENQUADRAMENTO do recorte por borderô: os seis cards
// medem o recorte escolhido, cada percentual declara a base, cancelado e acordo
// cancelado nunca se somam, e o detalhe pede ao banco o indicador e o borderô
// certos. Nenhuma conta acontece no front — o dublê devolve um payload com a
// forma exata da RPC, e o teste confere o que a tela faz com ele.
const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: { rpc: (...a) => rpcMock(...a) },
}));

import EfetividadeBorderos from "./EfetividadeBorderos";

const B706 = {
  importacao_id: "11111111-1111-1111-1111-111111111111",
  bordero_ref: "706", bordero_arquivo: "Borderô 706.xls", bordero_entrada: "2026-09-09",
  titulos: 1128, alunos: 1103, valor_original: 2618936.2,
  recuperado: 209072.21, titulos_com_pagamento: 126, titulos_liquidados: 106,
  convertido_titulos: 147, convertido_valor: 311040.7,
  conferencia_titulos: 402, conferencia_valor: 980100.5,
  academico_titulos: 20, academico_valor: 40000,
  sem_negociacao_titulos: 559, sem_negociacao_valor: 1287795,
  cancelado_titulos: 0, cancelado_valor: 0,
  acordos_cancelados: 0, acordos_cancelados_valor: 0,
  saldo_titulos: 1022, saldo_valor: 2409863.99,
  fallback_titulos: 0, fallback_valor: 0,
};
const B698 = {
  importacao_id: "22222222-2222-2222-2222-222222222222",
  bordero_ref: "698", bordero_arquivo: "Borderô 698.xls", bordero_entrada: "2026-08-11",
  titulos: 551, alunos: 548, valor_original: 1832750.68,
  recuperado: 219442.58, titulos_com_pagamento: 78, titulos_liquidados: 73,
  convertido_titulos: 91, convertido_valor: 251087.39,
  conferencia_titulos: 183, conferencia_valor: 549122.15,
  academico_titulos: 42, academico_valor: 100360.83,
  sem_negociacao_titulos: 234, sem_negociacao_valor: 921780.67,
  cancelado_titulos: 1, cancelado_valor: 10399.64,
  acordos_cancelados: 1, acordos_cancelados_valor: 12000,
  saldo_titulos: 470, saldo_valor: 1602908.46,
  fallback_titulos: 0, fallback_valor: 0,
};
const PAINEL = {
  gerado_em: "2026-09-27T17:40:00Z",
  semestre: "2026/2",
  atualizado_em: { prime_coletado_em: "2026-09-26T09:00:00Z", ultimo_bordero: "2026-09-09",
                   titulo_mexido_em: "2026-09-27T12:00:00Z" },
  total: {
    borderos: 2, titulos: 1679, alunos: 1651, valor_original: 4451686.88,
    recuperado: 428514.79, titulos_com_pagamento: 204, titulos_liquidados: 179,
    convertido_titulos: 238, convertido_valor: 562128.09,
    conferencia_titulos: 585, conferencia_valor: 1529222.65,
    academico_titulos: 62, academico_valor: 140360.83,
    sem_negociacao_titulos: 793, sem_negociacao_valor: 2209575.67,
    cancelado_titulos: 1, cancelado_valor: 10399.64,
    acordos_cancelados: 1, acordos_cancelados_valor: 12000,
    saldo_titulos: 1492, saldo_valor: 4012772.45,
    fallback_titulos: 0, fallback_valor: 0,
  },
  cancelados_por_motivo: [{ motivo: "Sem motivo registrado", titulos: 1, valor: 10399.64 }],
  borderos: [B706, B698],
};
const DETALHE = {
  indicador: "recuperado", importacao_id: null, total_titulos: 204, total_valor: 428514.79,
  limite: 200, offset: 0,
  linhas: [{ aluno: "ALUNO DE TESTE", cpf: "123.***.789-**", documento: "0001234567",
             vencimento: "2026-08-10", valor_original: 1500, bordero: "706", acordo: "71903",
             acordo_estado: "regular", situacao: "Negociado regular", recuperado: 500,
             saldo: 1000, motivo_cancelamento: null, fonte_semestre: "série do Prime" }],
};

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation((nome) => {
    if (nome === "carteira_2026_2_borderos") return Promise.resolve({ data: PAINEL });
    if (nome === "carteira_2026_2_bordero_detalhe") return Promise.resolve({ data: DETALHE });
    return Promise.resolve({ data: null });
  });
});
afterEach(() => cleanup());

async function abrir() {
  await act(async () => { render(<EfetividadeBorderos />); });
}

describe("Efetividade 2026/2 por borderô", () => {
  it("abre em todos os borderôs e os seis cards medem o semestre inteiro", async () => {
    await abrir();
    // Os mesmos seis rótulos também são atalhos dentro de cada card de borderô;
    // aqui interessam só os cards do topo.
    const topo = within(screen.getByRole("group", { name: "Indicadores do recorte" }));
    for (const t of ["Entradas", "Recuperado", "Convertido", "Em conferência",
                     "Cancelados", "Saldo a recuperar"]) {
      expect(topo.getByText(t)).toBeTruthy();
    }
    // valor original do semestre, títulos e alunos únicos
    expect(screen.getByText("R$ 4,45 mi")).toBeTruthy();
    expect(screen.getByText("1.679 títulos recebidos para cobrança")).toBeTruthy();
    expect(screen.getByText("1.651 alunos únicos")).toBeTruthy();
    // recuperado com os dois contadores que o pedido exige
    expect(screen.getByText("204 títulos com pagamento")).toBeTruthy();
    expect(screen.getByText("179 totalmente liquidados")).toBeTruthy();
  });

  it("todo percentual declara a base de cálculo", async () => {
    await abrir();
    // 428.514,79 / 4.451.686,88 = 9,6%
    expect(screen.getByText("9,6% do valor original que entrou")).toBeTruthy();
    // 562.128,09 / 4.451.686,88 = 12,6%
    expect(screen.getByText("12,6% do valor original que entrou")).toBeTruthy();
    expect(screen.getAllByText(/base dos dois percentuais: R\$ /).length).toBe(2);
  });

  it("cancelado de cobrança e acordo cancelado ficam separados", async () => {
    await abrir();
    expect(screen.getByText("1 títulos com a cobrança cancelada")).toBeTruthy();
    expect(screen.getByText("1 acordos cancelados (conceito separado)")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cancelados por motivo" })).toBeTruthy();
    expect(screen.getByText("Sem motivo registrado")).toBeTruthy();
    expect(screen.getByText(/Acordo\s+cancelado não é cobrança cancelada/)).toBeTruthy();
  });

  it("informa quando os dados foram atualizados", async () => {
    await abrir();
    expect(screen.getByText(/dados atualizados em/)).toBeTruthy();
    expect(screen.getByText(/situação no Prime coletada em/)).toBeTruthy();
    expect(screen.getByText(/último borderô importado em 09\/09\/2026/)).toBeTruthy();
  });

  it("um card por borderô, com número, semestre, entrada e recuperado", async () => {
    await abrir();
    expect(screen.getByText("Borderô 706")).toBeTruthy();
    expect(screen.getByText("Borderô 698")).toBeTruthy();
    expect(screen.getAllByText("2026/2").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("entrou em 09/09/2026")).toBeTruthy();
    expect(screen.getByText("1.128 títulos · 1.103 alunos ·", { exact: false })).toBeTruthy();
    expect(screen.getByText("126 com pagamento · 106 liquidados")).toBeTruthy();
  });

  it("escolher um borderô troca o que os cards de cima medem", async () => {
    await abrir();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Borderô de 2026/2"),
                       { target: { value: B698.importacao_id } });
    });
    // passa a medir só o 698
    expect(screen.getByText("551 títulos recebidos para cobrança")).toBeTruthy();
    expect(screen.getByText("548 alunos únicos")).toBeTruthy();
    // e a lista de baixo fica só com ele
    expect(screen.getByText("Borderô 698")).toBeTruthy();
    expect(screen.queryByText("Borderô 706")).toBeNull();
    expect(screen.getByRole("heading", { name: "Borderô selecionado" })).toBeTruthy();
  });

  it("clicar em um card pede ao banco o indicador certo, sem borderô", async () => {
    await abrir();
    const topo = within(screen.getByRole("group", { name: "Indicadores do recorte" }));
    await act(async () => { fireEvent.click(topo.getByTitle("Ver os títulos que compõem Recuperado")); });
    expect(rpcMock).toHaveBeenCalledWith("carteira_2026_2_bordero_detalhe", {
      p_importacao_id: null, p_indicador: "recuperado", p_limite: 200, p_offset: 0,
    });
    const painel = within(screen.getByRole("dialog"));
    expect(painel.getByText("ALUNO DE TESTE")).toBeTruthy();
    // a coluna de valor acompanha a grandeza do card: Recuperado, não valor original
    expect(painel.getByRole("columnheader", { name: "Recuperado" })).toBeTruthy();
    expect(painel.getByText("R$ 500,00")).toBeTruthy();
  });

  it("o botão dentro do card do borderô manda o importacao_id daquele borderô", async () => {
    await abrir();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Ver os títulos de Saldo a recuperar do borderô 706"));
    });
    expect(rpcMock).toHaveBeenCalledWith("carteira_2026_2_bordero_detalhe", {
      p_importacao_id: B706.importacao_id, p_indicador: "saldo", p_limite: 200, p_offset: 0,
    });
  });

  it("diz quanto do recorte entrou pelo vencimento em vez da série do Prime", async () => {
    // Sem fallback a linha não existe...
    await abrir();
    expect(screen.queryByText(/entram em 2026\/2 pelo vencimento/)).toBeNull();
    cleanup();
    // ...e com fallback ela aparece com o número medido em produção em 27/09.
    rpcMock.mockImplementation((nome) =>
      nome === "carteira_2026_2_borderos"
        ? Promise.resolve({ data: { ...PAINEL,
            total: { ...PAINEL.total, fallback_titulos: 160, fallback_valor: 42574.66 } } })
        : Promise.resolve({ data: null }));
    await abrir();
    expect(screen.getByText(/160 títulos \(R\$ 42\.574,66, 1,0% do valor original\)/)).toBeTruthy();
  });

  // Achado ao medir a RPC em producao em 27/09: `borderos` traz 16 blocos (15
  // remessas + 1 titulo sem importacao_id) enquanto total.borderos traz 15. A
  // tela nao pode mostrar um numero no seletor e outro no cabecalho.
  it("o título sem borderô não conta como remessa, mas aparece", async () => {
    const ORFAO = { importacao_id: null, bordero_ref: null, bordero_arquivo: null,
      bordero_entrada: null, titulos: 1, alunos: 1, valor_original: 13643.33,
      recuperado: 0, titulos_com_pagamento: 0, titulos_liquidados: 0,
      convertido_titulos: 0, convertido_valor: 0, conferencia_titulos: 1,
      conferencia_valor: 13643.33, academico_titulos: 0, academico_valor: 0,
      sem_negociacao_titulos: 0, sem_negociacao_valor: 0, cancelado_titulos: 0,
      cancelado_valor: 0, acordos_cancelados: 0, acordos_cancelados_valor: 0,
      saldo_titulos: 1, saldo_valor: 13643.33, fallback_titulos: 0, fallback_valor: 0 };
    rpcMock.mockImplementation((nome) =>
      nome === "carteira_2026_2_borderos"
        ? Promise.resolve({ data: { ...PAINEL, borderos: [B706, B698, ORFAO] } })
        : Promise.resolve({ data: null }));
    await abrir();
    // total.borderos continua 2: o órfão NÃO entra na contagem, nos dois lugares
    expect(screen.getByText("2 remessas + títulos sem borderô")).toBeTruthy();
    expect(screen.getByRole("option", { name: /Todos os borderôs do semestre \(2\)/ })).toBeTruthy();
    // mas o valor dele é visível, com card próprio e explicação
    expect(screen.getByText("Sem borderô identificado")).toBeTruthy();
    expect(screen.getByText(/1 título de 2026\/2 \(R\$ 13\.643,33\) entrou sem borderô de origem/)).toBeTruthy();
  });

  it("sem borderô nenhum, avisa em vez de desenhar cards vazios", async () => {
    rpcMock.mockImplementation((nome) =>
      nome === "carteira_2026_2_borderos"
        ? Promise.resolve({ data: { ...PAINEL, borderos: [] } })
        : Promise.resolve({ data: null }));
    await abrir();
    expect(screen.getByText("Nenhum borderô com título de 2026/2.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Indicadores do recorte" })).toBeNull();
  });
});

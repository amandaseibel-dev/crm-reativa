// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";

// O que se prova aqui é o ENQUADRAMENTO do recorte por competência: os seis
// cards medem o recorte escolhido, cada percentual declara a base, cancelado e
// acordo cancelado nunca se somam, e o detalhe pede ao banco a competência e o
// indicador certos. Nenhuma conta acontece no front — o dublê devolve um
// payload com a forma exata da RPC, e o teste confere o que a tela faz com ele.
const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: { rpc: (...a) => rpcMock(...a) },
}));

import EfetividadeCompetencias from "./EfetividadeCompetencias";

// Números reais medidos em produção em 27/09/2026.
const AGOSTO = {
  competencia: "2026-08-01", vencimento_de: "2026-08-05", vencimento_ate: "2026-08-10",
  datas_de_vencimento: 5, titulos: 1513, alunos: 1501, valor_original: 2798476.3,
  recuperado: 222049.4, titulos_com_pagamento: 163, titulos_liquidados: 139,
  convertido_titulos: 190, convertido_valor: 336923.35,
  conferencia_titulos: 281, conferencia_valor: 410577.17,
  academico_titulos: 8, academico_valor: 56542.83,
  sem_negociacao_titulos: 1034, sem_negociacao_valor: 1994432.95,
  cancelado_titulos: 0, cancelado_valor: 0,
  acordos_cancelados: 0, acordos_cancelados_valor: 0,
  saldo_titulos: 1374, saldo_valor: 2576426.9,
  fallback_titulos: 73, fallback_valor: 14205.07,
};
const JULHO = {
  competencia: "2026-07-01", vencimento_de: "2026-07-01", vencimento_ate: "2026-07-30",
  datas_de_vencimento: 19, titulos: 793, alunos: 790, valor_original: 1951591.07,
  recuperado: 232542.98, titulos_com_pagamento: 107, titulos_liquidados: 100,
  convertido_titulos: 143, convertido_valor: 278383.72,
  conferencia_titulos: 248, conferencia_valor: 985134.01,
  academico_titulos: 28, academico_valor: 42533.05,
  sem_negociacao_titulos: 373, sem_negociacao_valor: 635140.65,
  cancelado_titulos: 1, cancelado_valor: 10399.64,
  acordos_cancelados: 1, acordos_cancelados_valor: 1189.57,
  saldo_titulos: 692, saldo_valor: 1708648.45,
  fallback_titulos: 86, fallback_valor: 14726.26,
};
// Dezembro tem UMA mensalidade: é o caso que pegava "1 mensalidades".
const DEZEMBRO = {
  competencia: "2026-12-01", vencimento_de: "2026-12-05", vencimento_ate: "2026-12-05",
  datas_de_vencimento: 1, titulos: 1, alunos: 1, valor_original: 13643.33,
  recuperado: 0, titulos_com_pagamento: 0, titulos_liquidados: 0,
  convertido_titulos: 0, convertido_valor: 0,
  conferencia_titulos: 1, conferencia_valor: 13643.33,
  academico_titulos: 0, academico_valor: 0,
  sem_negociacao_titulos: 0, sem_negociacao_valor: 0,
  cancelado_titulos: 0, cancelado_valor: 0,
  acordos_cancelados: 0, acordos_cancelados_valor: 0,
  saldo_titulos: 1, saldo_valor: 13643.33,
  fallback_titulos: 1, fallback_valor: 13643.33,
};
const PAINEL = {
  gerado_em: "2026-09-27T22:20:00Z",
  semestre: "2026/2",
  atualizado_em: { prime_coletado_em: "2026-09-27T21:58:26Z", ultima_entrada: "2026-09-09",
                   titulo_mexido_em: "2026-09-27T03:50:00Z" },
  total: {
    competencias: 3, titulos: 2307, alunos: 2292,
    vencimento_de: "2026-07-01", vencimento_ate: "2026-12-05",
    valor_original: 4763710.7, recuperado: 454592.38,
    titulos_com_pagamento: 270, titulos_liquidados: 239,
    convertido_titulos: 333, convertido_valor: 615307.07,
    conferencia_titulos: 530, conferencia_valor: 1409354.51,
    academico_titulos: 36, academico_valor: 99075.88,
    sem_negociacao_titulos: 1407, sem_negociacao_valor: 2629573.6,
    cancelado_titulos: 1, cancelado_valor: 10399.64,
    acordos_cancelados: 1, acordos_cancelados_valor: 1189.57,
    saldo_titulos: 2067, saldo_valor: 4298718.68,
    fallback_titulos: 160, fallback_valor: 42574.66,
  },
  cancelados_por_motivo: [{ motivo: "Sem motivo registrado", titulos: 1, valor: 10399.64 }],
  competencias: [DEZEMBRO, AGOSTO, JULHO],
};
const DETALHE = {
  indicador: "recuperado", competencia: null, total_titulos: 270, total_valor: 454592.38,
  limite: 200, offset: 0,
  linhas: [{ aluno: "ALUNO DE TESTE", cpf: "123.***.789-**", documento: "0001234567",
             vencimento: "2026-08-10", competencia: "2026-08-01", valor_original: 1500,
             acordo: "71903", acordo_estado: "regular", situacao: "Negociado regular",
             recuperado: 500, saldo: 1000, motivo_cancelamento: null,
             fonte_semestre: "série do Prime" }],
};

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation((nome) => {
    if (nome === "carteira_2026_2_competencias") return Promise.resolve({ data: PAINEL });
    if (nome === "carteira_2026_2_competencia_detalhe") return Promise.resolve({ data: DETALHE });
    return Promise.resolve({ data: null });
  });
});
afterEach(() => cleanup());

async function abrir() {
  await act(async () => { render(<EfetividadeCompetencias />); });
}
const topo = () => within(screen.getByRole("group", { name: "Indicadores do recorte" }));

describe("Efetividade 2026/2 por competência", () => {
  it("abre em todas as competências e os seis cards medem o semestre inteiro", async () => {
    await abrir();
    for (const t of ["Entradas", "Recuperado", "Convertido", "Em conferência",
                     "Cancelados", "Saldo a recuperar"]) {
      expect(topo().getByText(t)).toBeTruthy();
    }
    expect(topo().getByText("R$ 4,76 mi")).toBeTruthy();
    expect(topo().getByText("2.307 mensalidades recebidas para cobrança")).toBeTruthy();
    expect(topo().getByText("2.292 alunos únicos")).toBeTruthy();
    expect(topo().getByText("270 mensalidades com pagamento")).toBeTruthy();
    expect(topo().getByText("239 totalmente liquidados")).toBeTruthy();
  });

  it("o card é o MÊS, não o borderô — e nenhum número de borderô aparece", async () => {
    await abrir();
    expect(screen.getByText("agosto/2026")).toBeTruthy();
    expect(screen.getByText("julho/2026")).toBeTruthy();
    expect(screen.getByText("dezembro/2026")).toBeTruthy();
    expect(screen.queryByText(/[Bb]orderô/)).toBeNull();
  });

  // O painel devolve do mais recente para o mais antigo, e isso punha
  // dezembro/2026 (1 mensalidade) na frente de agosto (R$ 2,8 mi).
  it("os meses aparecem em ordem cronológica, não na ordem do banco", async () => {
    await abrir();
    const nomes = screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"));
    expect(nomes).toEqual([
      "Mensalidades de julho/2026",
      "Mensalidades de agosto/2026",
      "Mensalidades de dezembro/2026",
    ]);
  });

  it("mês com uma data de vencimento mostra a data; com várias, o intervalo", async () => {
    await abrir();
    // julho tem 19 datas distintas
    expect(screen.getByText("venc. 01/07/2026 a 30/07/2026")).toBeTruthy();
    // dezembro tem uma só
    expect(screen.getByText("venc. 05/12/2026")).toBeTruthy();
  });

  it("todo percentual declara a base de cálculo", async () => {
    await abrir();
    // 454.592,38 / 4.763.710,70 = 9,5%
    expect(topo().getByText("9,5% do valor original que entrou")).toBeTruthy();
    // 615.307,07 / 4.763.710,70 = 12,9%
    expect(topo().getByText("12,9% do valor original que entrou")).toBeTruthy();
    expect(screen.getAllByText(/base dos dois percentuais: R\$ /).length).toBe(3);
  });

  it("cancelado de cobrança e acordo cancelado ficam separados", async () => {
    await abrir();
    expect(topo().getByText("1 mensalidade com a cobrança cancelada")).toBeTruthy();
    expect(topo().getByText("1 acordo cancelado (conceito separado)")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cancelados por motivo" })).toBeTruthy();
    expect(screen.getByText("Sem motivo registrado")).toBeTruthy();
    expect(screen.getByText(/Acordo\s+cancelado não é cobrança cancelada/)).toBeTruthy();
  });

  it("o singular não vira plural: dezembro tem UMA mensalidade", async () => {
    await abrir();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Competência de 2026/2"),
                       { target: { value: "2026-12-01" } });
    });
    expect(topo().getByText("1 mensalidade recebida para cobrança")).toBeTruthy();
    expect(topo().getByText("1 aluno único")).toBeTruthy();
    expect(topo().getByText("1 mensalidade com saldo")).toBeTruthy();
  });

  it("informa quando os dados foram atualizados", async () => {
    await abrir();
    expect(screen.getByText(/dados atualizados em/)).toBeTruthy();
    expect(screen.getByText(/situação no Prime coletada em/)).toBeTruthy();
    expect(screen.getByText(/última entrada na carteira em 09\/09\/2026/)).toBeTruthy();
  });

  it("escolher uma competência troca o que os cards de cima medem", async () => {
    await abrir();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Competência de 2026/2"),
                       { target: { value: "2026-07-01" } });
    });
    expect(topo().getByText("793 mensalidades recebidas para cobrança")).toBeTruthy();
    expect(topo().getByText("790 alunos únicos")).toBeTruthy();
    expect(screen.getByText("julho/2026")).toBeTruthy();
    expect(screen.queryByText("agosto/2026")).toBeNull();
    expect(screen.getByRole("heading", { name: "Competência selecionada" })).toBeTruthy();
  });

  it("clicar em um card do topo pede o indicador certo, sem competência", async () => {
    await abrir();
    await act(async () => { fireEvent.click(topo().getByTitle("Ver os títulos que compõem Recuperado")); });
    expect(rpcMock).toHaveBeenCalledWith("carteira_2026_2_competencia_detalhe", {
      p_competencia: null, p_indicador: "recuperado", p_limite: 200, p_offset: 0,
    });
    const painel = within(screen.getByRole("dialog"));
    expect(painel.getByText("ALUNO DE TESTE")).toBeTruthy();
    // a coluna de valor acompanha a grandeza do card: Recuperado, não valor original
    expect(painel.getByRole("columnheader", { name: "Recuperado" })).toBeTruthy();
    expect(painel.getByText("R$ 500,00")).toBeTruthy();
    // e a coluna de origem mostra a competência, não borderô
    expect(painel.getByRole("columnheader", { name: "Competência" })).toBeTruthy();
    expect(painel.getByText("ago/2026")).toBeTruthy();
  });

  it("o botão dentro do card do mês manda a competência daquele mês", async () => {
    await abrir();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Ver os títulos de Saldo a recuperar de agosto/2026"));
    });
    expect(rpcMock).toHaveBeenCalledWith("carteira_2026_2_competencia_detalhe", {
      p_competencia: "2026-08-01", p_indicador: "saldo", p_limite: 200, p_offset: 0,
    });
  });

  it("diz quanto do recorte entrou pelo vencimento em vez da série do Prime", async () => {
    await abrir();
    expect(screen.getByText(/160 mensalidades \(R\$ 42\.574,66, 0,9% do valor original\)/)).toBeTruthy();
  });

  it("sem competência nenhuma, avisa em vez de desenhar cards vazios", async () => {
    rpcMock.mockImplementation((nome) =>
      nome === "carteira_2026_2_competencias"
        ? Promise.resolve({ data: { ...PAINEL, competencias: [] } })
        : Promise.resolve({ data: null }));
    await abrir();
    expect(screen.getByText("Nenhuma mensalidade de 2026/2 em cobrança.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Indicadores do recorte" })).toBeNull();
  });
});

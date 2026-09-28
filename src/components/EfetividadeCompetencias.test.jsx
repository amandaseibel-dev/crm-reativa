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
    for (const t of ["Entradas", "Recuperado por rateio", "Convertido", "Em conferência",
                     "Cancelados", "Saldo residual da carteira"]) {
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
      "Mensalidades com vencimento em julho/2026",
      "Mensalidades com vencimento em agosto/2026",
      "Mensalidades com vencimento em dezembro/2026",
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
      fireEvent.change(screen.getByLabelText("Mês de vencimento de 2026/2"),
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
      fireEvent.change(screen.getByLabelText("Mês de vencimento de 2026/2"),
                       { target: { value: "2026-07-01" } });
    });
    expect(topo().getByText("793 mensalidades recebidas para cobrança")).toBeTruthy();
    expect(topo().getByText("790 alunos únicos")).toBeTruthy();
    expect(screen.getByText("julho/2026")).toBeTruthy();
    expect(screen.queryByText("agosto/2026")).toBeNull();
    expect(screen.getByRole("heading", { name: "Mês selecionado" })).toBeTruthy();
  });

  it("clicar em um card do topo pede o indicador certo, sem competência", async () => {
    await abrir();
    await act(async () => { fireEvent.click(topo().getByTitle("Ver os títulos que compõem Recuperado por rateio")); });
    expect(rpcMock).toHaveBeenCalledWith("carteira_2026_2_competencia_detalhe", {
      p_competencia: null, p_indicador: "recuperado", p_limite: 200, p_offset: 0,
    });
    const painel = within(screen.getByRole("dialog"));
    expect(painel.getByText("ALUNO DE TESTE")).toBeTruthy();
    // a coluna de valor acompanha a grandeza do card: Recuperado, não valor original
    expect(painel.getByRole("columnheader", { name: "Recuperado" })).toBeTruthy();
    expect(painel.getByText("R$ 500,00")).toBeTruthy();
    // e a coluna de origem mostra a competência, não borderô
    expect(painel.getByRole("columnheader", { name: "Mês venc." })).toBeTruthy();
    expect(painel.getByText("ago/2026")).toBeTruthy();
  });

  it("o botão dentro do card do mês manda a competência daquele mês", async () => {
    await abrir();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Ver os títulos de Saldo residual da carteira com vencimento em agosto/2026"));
    });
    expect(rpcMock).toHaveBeenCalledWith("carteira_2026_2_competencia_detalhe", {
      p_competencia: "2026-08-01", p_indicador: "saldo", p_limite: 200, p_offset: 0,
    });
  });

  it("diz quanto do recorte entrou pelo vencimento em vez da série do Prime", async () => {
    await abrir();
    expect(screen.getByText(/160 mensalidades \(R\$ 42\.574,66, 0,9% do valor original\)/)).toBeTruthy();
  });


  // REVISAO 27/09: o card dizia que os titulos em conferencia "nao entram no
  // saldo", mas o classificador calcula saldo para TODO titulo nao cancelado.
  // Os R$ 1,53 mi em conferencia estavam la o tempo todo.
  it("o saldo é apresentado como RESIDUAL e diz o que inclui", async () => {
    await abrir();
    const card = within(topo().getByText("Saldo residual da carteira").closest("button"));
    expect(card.getByText(/inclui conferência e ajuste acadêmico pendentes de conciliação/)).toBeTruthy();
    expect(card.getByText(/não é saldo confirmado para cobrança/)).toBeTruthy();
    // e o card de conferência não afirma mais que está fora do saldo
    expect(screen.queryByText("não entram em Convertido nem no saldo")).toBeNull();
    const conf = within(topo().getByText("Em conferência").closest("button"));
    expect(conf.getByText(/continuam dentro do saldo residual/)).toBeTruthy();
  });

  it("a composição do saldo soma exatamente o saldo, com as quatro parcelas", async () => {
    await abrir();
    const sec = within(screen.getByRole("heading", { name: "Composição do saldo residual" }).closest("section"));
    // sem negociação 2.629.573,60 + conferência 1.409.354,51
    // + resíduo (615.307,07 − 454.592,38 = 160.714,69) + acadêmico 99.075,88
    // = 4.298.718,68, exatamente o saldo do painel
    expect(sec.getByText("R$ 2.629.573,60")).toBeTruthy();
    expect(sec.getByText("R$ 1.409.354,51")).toBeTruthy();
    expect(sec.getByText("R$ 160.714,69")).toBeTruthy();
    expect(sec.getByText("R$ 99.075,88")).toBeTruthy();
    expect(sec.getByText(/as quatro parcelas somam o saldo/)).toBeTruthy();
    expect(sec.getByText(/R\$ 4\.298\.718,68/)).toBeTruthy();
    expect(sec.getByText(/Só 61,2% do saldo é dívida sem nenhuma negociação/)).toBeTruthy();
  });

  it("cada parcela da composição abre o detalhe do próprio indicador", async () => {
    await abrir();
    const sec = within(screen.getByRole("heading", { name: "Composição do saldo residual" }).closest("section"));
    await act(async () => { fireEvent.click(sec.getByTitle("Ver os títulos de Em conferência, a conciliar")); });
    expect(rpcMock).toHaveBeenCalledWith("carteira_2026_2_competencia_detalhe", {
      p_competencia: null, p_indicador: "em_conferencia", p_limite: 200, p_offset: 0,
    });
  });

  it("o card de recuperado diz que é rateio, não caixa", async () => {
    await abrir();
    const card = within(topo().getByText("Recuperado por rateio").closest("button"));
    expect(card.getByText(/principal proporcional às parcelas pagas do acordo/)).toBeTruthy();
    expect(card.getByText(/não é caixa recebido/)).toBeTruthy();
    expect(screen.queryByText(/valor efetivamente recebido/)).toBeNull();
  });

  it("explica por que 2026/2 tem mensalidade vencendo antes de julho", async () => {
    // Sem mês anterior a julho o aviso NÃO deve existir...
    await abrir();
    expect(screen.queryByText(/série de cobrança do Prime/)).toBeNull();
    cleanup();
    // ...e com abril na lista, ele aparece e diz por quê.
    const ABRIL = { ...DEZEMBRO, competencia: "2026-04-01",
                    vencimento_de: "2026-04-05", vencimento_ate: "2026-04-05",
                    titulos: 3, alunos: 3, valor_original: 2680.77 };
    rpcMock.mockImplementation((nome) =>
      nome === "carteira_2026_2_competencias"
        ? Promise.resolve({ data: { ...PAINEL, competencias: [ABRIL, AGOSTO, JULHO, DEZEMBRO] } })
        : Promise.resolve({ data: DETALHE }));
    await abrir();
    expect(screen.getByText(/série de cobrança do Prime/)).toBeTruthy();
    expect(screen.getByText(/218 mensalidades com vencimento entre abril e junho/)).toBeTruthy();
    expect(screen.getByText(/não são excluídas/)).toBeTruthy();
  });

  // Agrupar pelo vencimento resolveu o recorte, NAO a rastreabilidade.
  it("o detalhamento marca quem entrou sem importação de origem", async () => {
    rpcMock.mockImplementation((nome) => {
      if (nome === "carteira_2026_2_competencias") return Promise.resolve({ data: PAINEL });
      return Promise.resolve({ data: { ...DETALHE, linhas: [
        { ...DETALHE.linhas[0], origem_importacao: "Borderô 706" },
        { ...DETALHE.linhas[0], aluno: "ORFAO", origem_importacao: null },
      ] } });
    });
    await abrir();
    await act(async () => { fireEvent.click(topo().getByTitle("Ver os títulos que compõem Entradas")); });
    const p = within(screen.getByRole("dialog"));
    expect(p.getByRole("columnheader", { name: "Origem" })).toBeTruthy();
    expect(p.getByText("Borderô 706")).toBeTruthy();
    expect(p.getByText("Sem importação de origem identificada")).toBeTruthy();
  });

  // Enquanto a migration da origem nao for aplicada a coluna nao existe: uma
  // coluna vazia diria que NINGUEM tem origem, que e falso.
  it("sem o campo no banco, a coluna Origem simplesmente não aparece", async () => {
    await abrir();
    await act(async () => { fireEvent.click(topo().getByTitle("Ver os títulos que compõem Entradas")); });
    const p = within(screen.getByRole("dialog"));
    expect(p.queryByRole("columnheader", { name: "Origem" })).toBeNull();
    expect(p.queryByText("Sem importação de origem identificada")).toBeNull();
  });


  // ---- REVISAO VISUAL 28/09: os tres defeitos vistos em producao ----

  // Em producao o painel escrevia "1 titulos" ao abrir Cancelados, que tem
  // exatamente um titulo em 2026/2.
  it("o resumo do detalhe usa singular quando há um único título", async () => {
    rpcMock.mockImplementation((nome) =>
      nome === "carteira_2026_2_competencias"
        ? Promise.resolve({ data: PAINEL })
        : Promise.resolve({ data: { ...DETALHE, indicador: "cancelado", total_titulos: 1,
            total_valor: 10399.64, linhas: [DETALHE.linhas[0]] } }));
    await abrir();
    await act(async () => { fireEvent.click(topo().getByTitle("Ver os títulos que compõem Cancelados")); });
    const p = within(screen.getByRole("dialog"));
    expect(p.getByText(/^1 título · R\$ 10\.399,64/)).toBeTruthy();
    expect(p.queryByText(/1 títulos/)).toBeNull();
  });

  it("o resumo do detalhe usa plural quando há mais de um", async () => {
    rpcMock.mockImplementation((nome) =>
      nome === "carteira_2026_2_competencias"
        ? Promise.resolve({ data: PAINEL })
        : Promise.resolve({ data: { ...DETALHE, total_titulos: 2, total_valor: 3000 } }));
    await abrir();
    await act(async () => { fireEvent.click(topo().getByTitle("Ver os títulos que compõem Entradas")); });
    expect(within(screen.getByRole("dialog")).getByText(/^2 títulos · /)).toBeTruthy();
  });

  // Um unico titulo com documento de 70 caracteres empurrava a coluna de valor
  // para fora da tela. Truncar sozinho nao basta: o identificador tem de seguir
  // consultavel e copiavel, inclusive no celular, onde nao ha hover.
  it("documento longo é truncado, mas o valor completo fica no DOM e é selecionável", async () => {
    const LONGO = "MANUAL-9419c3bc-942b-43dd-a20c-bd491f925fee-2026/01-2026-12-05-1364333";
    rpcMock.mockImplementation((nome) =>
      nome === "carteira_2026_2_competencias"
        ? Promise.resolve({ data: PAINEL })
        : Promise.resolve({ data: { ...DETALHE, linhas: [
            { ...DETALHE.linhas[0], documento: LONGO },
            { ...DETALHE.linhas[0], aluno: "CURTO", documento: "4533631" }] } }));
    await abrir();
    await act(async () => { fireEvent.click(topo().getByTitle("Ver os títulos que compõem Entradas")); });
    const p = within(screen.getByRole("dialog"));

    // o texto INTEIRO está no DOM mesmo truncado: o dado não se perde
    const celula = p.getByText(LONGO);
    expect(celula).toBeTruthy();
    expect(celula.style.userSelect).toBe("all");        // um clique seleciona tudo
    expect(celula.style.textOverflow).toBe("ellipsis"); // truncado visualmente
    expect(celula.style.whiteSpace).toBe("nowrap");

    // e existe um caminho de leitura que NAO depende de hover/title
    const botao = p.getByRole("button", { name: "ver completo" });
    expect(botao.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { fireEvent.click(botao); });
    expect(p.getByRole("button", { name: "ocultar" }).getAttribute("aria-expanded")).toBe("true");
    const aberto = p.getByText(LONGO);
    expect(aberto.style.whiteSpace).toBe("normal");
    expect(aberto.style.wordBreak).toBe("break-all");
    expect(aberto.style.userSelect).toBe("all");

    // documento curto não ganha botão nenhum
    expect(p.queryAllByRole("button", { name: /ver completo|ocultar/ }).length).toBe(1);
  });

  // A grade 5+1 nasceu de um minimo pequeno demais combinado com a barra
  // lateral. Este teste prende a decisao: 300px garante 3 colunas na area util
  // do CRM (1.072px) e impede 4 (o container tem maxWidth 1120).
  it("a grade dos cards usa o mínimo que dá 3 colunas na largura do CRM", async () => {
    await abrir();
    const grade = screen.getByRole("group", { name: "Indicadores do recorte" });
    expect(grade.style.gridTemplateColumns).toBe("repeat(auto-fit, minmax(300px, 1fr))");
    const AREA_CRM = 1072, MIN = 300, GAP = 12;
    const cabem = (area) => Math.max(1, Math.floor((area + GAP) / (MIN + GAP)));
    expect(cabem(AREA_CRM)).toBe(3);   // 3+3, nunca 5+1
    expect(cabem(896)).toBe(2);        // lateral recolhida
    expect(cabem(664)).toBe(2);        // tablet
    expect(cabem(343)).toBe(1);        // celular 375px
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

// ---------------------------------------------------------------------------
// CONFERIR EM ABERTO
//
// O que estes testes protegem nao e o visual: e que a tela nao invente e nao
// esconda. A confirmacao so pode ser oferecida na faixa certa, so pode ser
// salva com justificativa e evidencia, e tem de mandar de volta o estado que
// FOI EXIBIDO -- sem isso, alguem confirma "em aberto, sem pagamento" sobre um
// titulo que acabou de ser pago enquanto a tela estava aberta.
// ---------------------------------------------------------------------------
const LINHA_CONF = {
  aluno: "ALUNO EM CONFERENCIA", cpf: "123.***.789-**", documento: "0009998888",
  vencimento: "2026-08-10", competencia: "2026-08-01", valor_original: 1571.55,
  acordo: "(sem número)", acordo_estado: "sem_acordo",
  situacao: "Liquidado no Prime, origem não comprovada",
  recuperado: 0, saldo: 1571.55, motivo_cancelamento: null,
  fonte_semestre: "série do Prime",
  // campos que so existem depois da migration desta proposta
  titulo_id: "11111111-1111-4111-8111-111111111111",
  situacao_crm: "ABERTO", prime_liquidado: "2026-09-09",
  conferido_por: null, conferido_em: null,
};
const DETALHE_CONF = {
  indicador: "em_conferencia", competencia: null, total_titulos: 1, total_valor: 1571.55,
  limite: 200, offset: 0, linhas: [LINHA_CONF],
};

async function abrirConferencia(linha = LINHA_CONF) {
  rpcMock.mockImplementation((nome) => {
    if (nome === "carteira_2026_2_competencias") return Promise.resolve({ data: PAINEL });
    if (nome === "carteira_2026_2_competencia_detalhe")
      return Promise.resolve({ data: { ...DETALHE_CONF, linhas: [linha] } });
    return Promise.resolve({ data: { ok: true, conferido_por: "gestao@teste" } });
  });
  await abrir();
  await act(async () => {
    fireEvent.click(topo().getByText("Em conferência").closest("button"));
  });
}

describe("Conferir em aberto", () => {
  it("a coluna só existe na faixa Em conferência", async () => {
    await abrirConferencia();
    expect(screen.getByRole("columnheader", { name: "Conferência" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Conferir em aberto" })).toBeTruthy();
  });

  it("sem a migration (linha sem titulo_id) a coluna não aparece, em vez de um botão que erraria", async () => {
    const semId = { ...LINHA_CONF };
    delete semId.titulo_id;
    await abrirConferencia(semId);
    expect(screen.queryByRole("columnheader", { name: "Conferência" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Conferir em aberto" })).toBeNull();
  });

  it("em outra faixa a coluna não aparece, mesmo com titulo_id na linha", async () => {
    rpcMock.mockImplementation((nome) => {
      if (nome === "carteira_2026_2_competencias") return Promise.resolve({ data: PAINEL });
      return Promise.resolve({ data: { ...DETALHE_CONF, indicador: "sem_negociacao" } });
    });
    await abrir();
    await act(async () => {
      fireEvent.click(topo().getByText("Saldo residual da carteira").closest("button"));
    });
    expect(screen.queryByRole("columnheader", { name: "Conferência" })).toBeNull();
  });

  it("o formulário diz que nada é baixado, cancelado ou quitado", async () => {
    await abrirConferencia();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Conferir em aberto" }));
    });
    expect(screen.getByText(/dívida devida, em aberto, sem pagamento ou negociação/i)).toBeTruthy();
    // O "não" está dentro de <strong>, então o texto vem quebrado em nós: casar
    // o trecho depois dele é o que funciona sem depender da marcação.
    expect(screen.getByText(/baixa, cancela nem quita nada/i)).toBeTruthy();
    expect(screen.getByText(/volta sozinho para esta faixa/i)).toBeTruthy();
  });

  it("não deixa registrar sem justificativa e sem evidência", async () => {
    await abrirConferencia();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Conferir em aberto" }));
    });
    const salvar = screen.getByRole("button", { name: "Registrar conferência" });
    expect(salvar.disabled).toBe(true);

    // justificativa curta demais: continua travado
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/O que você conferiu/i), { target: { value: "curto" } });
      fireEvent.change(screen.getByLabelText(/Referência da evidência/i), { target: { value: "Prime" } });
    });
    expect(screen.getByRole("button", { name: "Registrar conferência" }).disabled).toBe(true);

    // com os dois preenchidos, libera
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/O que você conferiu/i),
        { target: { value: "conferido na tela do Prime, boleto em aberto sem baixa" } });
    });
    expect(screen.getByRole("button", { name: "Registrar conferência" }).disabled).toBe(false);
  });

  it("manda ao banco o ESTADO QUE EXIBIU, não só o id — é o que impede confirmar o que mudou", async () => {
    await abrirConferencia();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Conferir em aberto" }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/O que você conferiu/i),
        { target: { value: "conferido na tela do Prime, boleto em aberto sem baixa" } });
      fireEvent.change(screen.getByLabelText(/Referência da evidência/i),
        { target: { value: "Prime, consulta de 28/09/2026" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Registrar conferência" }));
    });
    const chamada = rpcMock.mock.calls.find((c) => c[0] === "carteira_conferir_em_aberto");
    expect(chamada).toBeTruthy();
    expect(chamada[1]).toEqual({
      p_titulo_id: LINHA_CONF.titulo_id,
      p_justificativa: "conferido na tela do Prime, boleto em aberto sem baixa",
      p_evidencia: "Prime, consulta de 28/09/2026",
      p_valor_visto: 1571.55,
      p_situacao_vista: "ABERTO",
      p_liquidado_visto: "2026-09-09",
    });
  });

  it("depois de registrar, a linha mostra o selo — a lista é uma fotografia e não se recarrega sozinha", async () => {
    await abrirConferencia();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Conferir em aberto" }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/O que você conferiu/i),
        { target: { value: "conferido na tela do Prime, boleto em aberto sem baixa" } });
      fireEvent.change(screen.getByLabelText(/Referência da evidência/i),
        { target: { value: "Prime, consulta de 28/09/2026" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Registrar conferência" }));
    });
    expect(screen.getByText("Conferido em aberto")).toBeTruthy();
    expect(screen.getByText("gestao@teste")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Conferir em aberto" })).toBeNull();
  });

  it("erro do banco aparece na tela e não some o formulário — ESTADO_MUDOU precisa ser lido", async () => {
    await abrirConferencia();
    rpcMock.mockImplementation((nome) => {
      if (nome === "carteira_2026_2_competencias") return Promise.resolve({ data: PAINEL });
      if (nome === "carteira_2026_2_competencia_detalhe") return Promise.resolve({ data: DETALHE_CONF });
      return Promise.resolve({ data: null, error: { message: "ESTADO_MUDOU: recarregue e confira de novo." } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Conferir em aberto" }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/O que você conferiu/i),
        { target: { value: "conferido na tela do Prime, boleto em aberto sem baixa" } });
      fireEvent.change(screen.getByLabelText(/Referência da evidência/i),
        { target: { value: "Prime, consulta de 28/09/2026" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Registrar conferência" }));
    });
    expect(screen.getByText(/ESTADO_MUDOU/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Registrar conferência" })).toBeTruthy();
    expect(screen.queryByText("Conferido em aberto")).toBeNull();
  });

  it("título já conferido no banco mostra quem conferiu, sem oferecer o botão de novo", async () => {
    await abrirConferencia({ ...LINHA_CONF, conferido_por: "outra.pessoa@teste",
                             conferido_em: "2026-09-28T12:00:00Z" });
    expect(screen.getByText("Conferido em aberto")).toBeTruthy();
    expect(screen.getByText("outra.pessoa@teste")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Conferir em aberto" })).toBeNull();
  });
});

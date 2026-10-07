// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// O que se prova aqui é o ENQUADRAMENTO da Efetividade redesenhada (07/10/2026):
// quatro blocos, um conjunto único de indicadores em toda safra, e NENHUMA
// informação repetida em cards diferentes. Nenhuma conta acontece no front —
// os valores vêm prontos das RPCs, então o dublê devolve o payload como ele é.
//
// A página virou a dona de `carteira_safra_situacoes`: o MESMO payload alimenta
// o resumo executivo do topo e o cartão das seis linhas, e é por isso que os
// dois não podem divergir. Os blocos novos (composição acadêmica, pendências
// por motivo, comparativo) têm teste próprio nos arquivos deles; aqui se prova
// que a página os monta no lugar certo e que os antigos saíram.
const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (...a) => rpcMock(...a),
    auth: { getUser: async () => ({ data: { user: { email: "amanda.seibel@aelbra.com.br" } } }) },
  },
}));

import CarteiraEfetividade from "./CarteiraEfetividade";

const POR_ANO = {
  prime_coletado_em: "2026-09-13",
  anos: [
    {
      ano: "2024",
      aberto: { alunos: 1991, mensalidades: 6411, valor: 3714151.57, valor_original: 3714151.57 },
      cursos: [
        { curso: "Graduação Presencial", alunos: 1246, mensalidades: 3925, valor: 3024268.62 },
        { curso: "Pós-Graduação (Lato Sensu)", alunos: 61, mensalidades: 327, valor: 47586.37 },
      ],
      carteira: { titulos: 8469, cpfs: 2528, valor_original: 5159080.84,
                  entrada_de: "2026-07-02", entrada_ate: "2026-07-06" },
      negociado: 61212.46, recebido: 44921.85,
      ulbra_166: { alunos: 258, mensalidades: 1049, valor: 613246.31 },
      liquidado_no_prime: { mensalidades: 886, valor: 687635.4 },
    },
    {
      ano: "2025",
      aberto: { alunos: 2967, mensalidades: 10710, valor: 6306015.48, valor_original: 6306015.48 },
      cursos: [{ curso: "Graduação Presencial", alunos: 1347, mensalidades: 4632, valor: 4711983.93 }],
      carteira: { titulos: 20851, cpfs: 5683, valor_original: 15197034.48,
                  entrada_de: "2026-07-02", entrada_ate: "2026-09-09" },
      negociado: 443712.53, recebido: 338011.03,
      ulbra_166: { alunos: 2043, mensalidades: 7370, valor: 5074170.88 },
      liquidado_no_prime: { mensalidades: 1911, valor: 1599179.48 },
    },
  ],
  sem_semestre: { alunos: 191, mensalidades: 486, valor: 81464.89 },
};

// Medido em produção em 06/10/2026 e mantido como está: a tela só usa este
// payload para o CONTEXTO do rodapé (congelamento e fotografia de referência).
// Os indicadores vêm de `carteira_safra_situacoes`, ao vivo.
const CONSOLIDADA = {
  base: { valor: 21710447.29, cpfs: 5250, titulos: 14979, congelada_em: "2026-09-11" },
  faixas: { efetividade: 11615720.75, inadimplencia: 9134866.22,
            em_validacao: 807802.95, academico: 152057.37 },
  recuperacao: { total: 6896336.45 },
  gerado_em: "2026-10-06",
};

// Valores validados de 2026/1: 2.522 alunos, 7.810 títulos e R$ 9.931.064,45 de
// saldo em aberto (inadimplência + em validação).
const SITUACOES = {
  recorte: "2026/1", natureza: "CARTEIRA_CONSOLIDADA",
  fonte: "carteira_2026_1_classificar() ao vivo", gerado_em: "2026-10-07T19:30:00Z",
  situacoes: {
    entrou:    { alunos: 5250, titulos: 14979, valor: 21710447.29 },
    pago:      { alunos: 1826, titulos: 5068, valor: 6896336.45 },
    negociado: { alunos: 944, titulos: 2961, valor: 4662443.01 },
    cancelado: { alunos: 3, titulos: 15, valor: 112595.16 },
    em_aberto: { alunos: 2522, titulos: 7810, valor: 9931064.45 },
    pendente:  { alunos: 1159, titulos: 2414, valor: 1793976.23 },
  },
  conferencia: { entrou: 21710447.29, soma_das_linhas: 21710447.29, diferenca: 0, fecha: true },
  pendente_detalhe: {},
};

const COMPOSICAO = {
  recorte: "2026/1", universo_em_aberto: "inadimplencia + em_validacao",
  total: { alunos: 2522, titulos: 7810, valor: 9931064.45 },
  linhas: [{ status: "Aguardando Matrícula", alunos: 2522, titulos: 7810, valor: 9931064.45 }],
  conferencia: { total_valor: 9931064.45, soma_das_linhas: 9931064.45, diferenca: 0,
                 fecha: true, titulos_total: 7810, titulos_soma: 7810 },
  fonte_academica: { importacao_atualizada_em: "2026-08-04T15:19:51Z" },
};

const PENDENCIAS = {
  recorte: "2026/1", contagens_somaveis: false,
  total: { alunos: 1159, titulos: 2414, valor: 1793976.23 },
  motivos: [{ chave: "em_validacao", rotulo: "Em validação",
              acao: "SEM_ACAO_AUTOMATICA_SEGURA", alunos: 500, titulos: 1000, valor: 807802.95 }],
  conferencia: { total_valor: 1793976.23, soma_das_linhas: 1793976.23, diferenca: 0, fecha: true },
};

const CASOS_PENDENTES = {
  casos_no_escopo: 12859, sem_pagamento: 11494, com_acordo_aberto: 2117,
  nos_dois: 972, pendentes: 12639,
};

const NEGOCIACOES = {
  gerado_em: "2026-09-29",
  total: { negociado: 453987.04, recebido: 120000, saldo: 333987.04,
           titulos: 268, cpfs: 246, acordos: 250 },
  estados: [{ estado: "Regular", negociado: 300000 }],
};
const CONTEXTO = {
  carteira_valor: 5127980.01, carteira_titulos: 2522, carteira_cpfs: 1900,
  remessas: 7, primeira_remessa: "2026-07-02", ultima_remessa: "2026-08-14",
};

// A fotografia e o estado dela. `snapshot` acompanha o payload porque a tela tem
// de dizer de quando o numero e -- e, quando houve movimentacao depois, dizer
// isso em vez de deixar o antigo passar por dado de agora.
const EM_DIA = { gerado_em: "2026-10-07T20:40:00Z", duracao_ms: 41000,
                 bloco: "situacoes", desatualizada: false,
                 invalidada_em: null, invalidada_por: null };
const PENDENTE = { ...EM_DIA, desatualizada: true,
                   invalidada_em: "2026-10-07T20:52:00Z", invalidada_por: "pagamentos" };

// A tela lê os tres blocos financeiros por UMA funcao -- a camada de
// desempenho -- e escolhe pelo `p_bloco`. As chaves logicas abaixo seguem sendo
// as mesmas; muda so o caminho. O payload que a camada devolve e o retorno
// VERBATIM da funcao oficial, por isso as fixtures nao mudaram de forma.
const BLOCO = { situacoes: { ...SITUACOES, snapshot: EM_DIA },
                academico: COMPOSICAO, pendencias: PENDENCIAS };

const PADRAO = {
  carteira_2026_1_indicadores: CONSOLIDADA,
  carteira_saldo_historico_por_ano: POR_ANO,
  casos_pendentes_contar: CASOS_PENDENTES,
  carteira_2026_2_negociacoes: NEGOCIACOES,
  carteira_2026_2_contexto: CONTEXTO,
  carteira_efetividade_pedir_atualizacao: { pedido_em: "2026-10-07T21:00:00Z", marcadas: 3,
                                            reconstroi_em_ate_minutos: 5 },
};

function responder(mapa = {}) {
  const tabela = { ...PADRAO, ...mapa };
  const blocos = { ...BLOCO, ...(mapa.__blocos || {}) };
  rpcMock.mockImplementation((nome, args) => {
    const alvo = nome === "carteira_efetividade_ler" ? blocos[args?.p_bloco] : tabela[nome];
    if (alvo === undefined) return Promise.resolve({ data: null });
    if (alvo?.__erro) return Promise.resolve({ data: null, error: alvo.__erro });
    return Promise.resolve({ data: alvo });
  });
}

// Conta leituras de um bloco da camada, que e o que antes era "chamadas da RPC
// oficial" -- a tela nao chama mais as oficiais direto.
const lidos = (bloco) =>
  rpcMock.mock.calls.filter((c) => c[0] === "carteira_efetividade_ler"
                               && c[1]?.p_bloco === bloco).length;

const txt = (el) => el.textContent.replace(/\u00a0/g, " ");

beforeEach(() => { rpcMock.mockReset(); responder(); });
afterEach(() => cleanup());

async function abrir() {
  await act(async () => {
    render(<MemoryRouter><CarteiraEfetividade /></MemoryRouter>);
  });
}
async function irPara(ano) {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: ano })); });
}
async function ir2026_2() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "2º semestre" })); });
}

// ---------------------------------------------------------------------------
describe("Efetividade — bloco 1: resumo da carteira, igual em toda safra", () => {
  it("tem os quatro indicadores na ordem de leitura pedida", async () => {
    await abrir();
    const rotulos = ["Universo recebido", "Recuperado", "Em aberto", "Efetividade"];
    for (const r of rotulos) expect(screen.getAllByText(r).length).toBeGreaterThanOrEqual(1);
    // A ordem é conferida DENTRO da grade de indicadores, não no corpo inteiro:
    // "Efetividade" também é o título da página, e começaria na posição 0.
    const grade = screen.getByText("Universo recebido").closest("div").parentElement;
    const texto = grade.textContent;
    const pos = rotulos.map((r) => texto.indexOf(r));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
  });

  it("os quatro vêm de carteira_safra_situacoes — a mesma fonte das seis linhas", async () => {
    await abrir();
    expect(rpcMock).toHaveBeenCalledWith("carteira_efetividade_ler",
      { p_bloco: "situacoes", p_ano: "2026", p_semestre: "1" });
    // uma chamada só: o resumo e o cartão compartilham o payload
    expect(lidos("situacoes")).toBe(1);
  });

  it("mostra universo, recuperado e em aberto com alunos e títulos como apoio", async () => {
    await abrir();
    expect(screen.getByText("R$ 21,71 mi")).toBeTruthy();
    expect(screen.getByText("R$ 9,93 mi")).toBeTruthy();
    expect(screen.getByText("5.250 alunos · 14.979 títulos")).toBeTruthy();
  });

  it("a efetividade é o recuperado sobre o universo recebido, e declara a conta", async () => {
    await abrir();
    // 6.896.336,45 / 21.710.447,29 = 31,8%
    expect(screen.getAllByText("31,8%").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("recuperado ÷ universo recebido")).toBeTruthy();
  });

  it("em 2024 o mesmo conjunto aparece, sem rótulo diferente por natureza de período", async () => {
    await abrir();
    await irPara("2024");
    expect(screen.getAllByText("Universo recebido").length).toBeGreaterThanOrEqual(1);
    // os rótulos antigos, específicos de cada período, não voltam
    expect(screen.queryByText("Carteira convertida")).toBeNull();
    expect(screen.queryByText("Valor recebido")).toBeNull();
    expect(screen.queryByText("Alunos com saldo em aberto")).toBeNull();
    expect(screen.queryByText("Negociado desde jul/2026")).toBeNull();
    expect(screen.queryByText("Recebido desde jul/2026")).toBeNull();
  });
});

describe("Efetividade — o que saiu por duplicação", () => {
  it("as barras de “Situação da carteira” sumiram fora de 2026/2", async () => {
    await abrir();
    expect(screen.queryByText("Situação da carteira")).toBeNull();
    expect(screen.queryByText("Convertido")).toBeNull();
    expect(screen.queryByText("Em aberto sem negociação")).toBeNull();
    expect(screen.queryByText("Encerrado / ajuste acadêmico")).toBeNull();
  });

  it("a lista acadêmica quantitativa saiu dos DOIS lugares em que aparecia", async () => {
    await abrir();
    expect(screen.queryByText("Alunos por status")).toBeNull();
    expect(screen.queryByText("Status acadêmico por safra")).toBeNull();
    expect(screen.queryByText("Perfil dos alunos")).toBeNull();
  });

  it("a RPC do snapshot acadêmico não é mais chamada pela página", async () => {
    await abrir();
    const nomes = rpcMock.mock.calls.map((c) => c[0]);
    expect(nomes).not.toContain("carteira_academico_perfil_ler");
  });

  it("em 2026/2 as barras PERMANECEM: ali elas são os estados do acordo", async () => {
    await abrir();
    await ir2026_2();
    expect(screen.getByText("Situação da carteira")).toBeTruthy();
    expect(screen.getByText("Regular")).toBeTruthy();
  });
});

describe("Efetividade — blocos 3 e 4, e o que só existe em certas safras", () => {
  it("monta a composição acadêmica e as pendências por motivo na safra selecionada", async () => {
    await abrir();
    expect(screen.getByText("Quem compõe o saldo em aberto")).toBeTruthy();
    expect(screen.getByText("Pendências de validação")).toBeTruthy();
    expect(rpcMock).toHaveBeenCalledWith("carteira_efetividade_ler",
      { p_bloco: "academico", p_ano: "2026", p_semestre: "1" });
    expect(rpcMock).toHaveBeenCalledWith("carteira_efetividade_ler",
      { p_bloco: "pendencias", p_ano: "2026", p_semestre: "1" });
  });

  it("2026/2 não recebe composição acadêmica nem pendências por safra", async () => {
    await abrir();
    await ir2026_2();
    expect(screen.queryByText("Quem compõe o saldo em aberto")).toBeNull();
    expect(screen.queryByText("Pendências de validação")).toBeNull();
    expect(screen.queryByText("As seis linhas da safra")).toBeNull();
  });

  it("2024 e 2025 mantêm o saldo por curso, que não é duplicata de nada", async () => {
    await abrir();
    await irPara("2024");
    expect(screen.getByRole("heading", { name: "Saldo em aberto por curso" })).toBeTruthy();
    expect(screen.getByText("Graduação Presencial")).toBeTruthy();
  });

  it("o contexto do ano vira rodapé, incluindo o balde 166 como exposição por CPF", async () => {
    await abrir();
    await irPara("2024");
    expect(screen.getByText(/Carteira residual do ano/)).toBeTruthy();
    expect(screen.getByText(/negociado direto com a Ulbra, a confirmar/)).toBeTruthy();
    expect(screen.getByText(/exposição por CPF/)).toBeTruthy();
  });

  it("em 2026/1 o rodapé não deixa parecer que os indicadores saem da fotografia de referência", async () => {
    await abrir();
    const r = txt(screen.getByText(/Carteira congelada em/));
    expect(r).toMatch(/fotografia de referência de/);
    expect(r).toMatch(/vêm de outra fotografia/);
    // o rodapé NÃO pode mais prometer "ao vivo": os valores são de fotografia
    expect(r).not.toMatch(/ao vivo/);
  });
});

describe("Efetividade — visão global, separada da safra", () => {
  it("“Casos ainda pendentes” fica numa área própria, declarada como carteira inteira", async () => {
    await abrir();
    expect(screen.getByText("Visão operacional da carteira inteira")).toBeTruthy();
    expect(screen.getByText(/não é da safra selecionada/)).toBeTruthy();
    expect(screen.getByText("Casos ainda pendentes")).toBeTruthy();
  });

  it("o número global não é fixo no código: vem da RPC", async () => {
    responder({ casos_pendentes_contar: { ...CASOS_PENDENTES, pendentes: 4242 } });
    await abrir();
    expect(screen.getByText("4.242")).toBeTruthy();
  });
});

describe("Efetividade — comparativo entre safras, compacto e sob demanda", () => {
  it("fechado, não dispara as três consultas", async () => {
    await abrir();
    expect(screen.getByRole("button", { name: /Comparar as safras/ })).toBeTruthy();
    expect(lidos("situacoes")).toBe(1);
  });

  it("aberto, compara com as cinco colunas executivas e nada mais", async () => {
    await abrir();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Comparar as safras/ }));
    });
    expect(screen.getByText("Comparativo entre safras")).toBeTruthy();
    expect(screen.getByText("Safra")).toBeTruthy();
    // 1 da página + 3 do comparativo
    expect(lidos("situacoes")).toBe(4);
  });
});

describe("Efetividade — política de atualização", () => {
  it("“Atualizar dados” refaz as consultas ao vivo, sem recarregar a aplicação", async () => {
    await abrir();
    const antes = lidos("situacoes");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Atualizar dados/ })); });
    expect(lidos("situacoes")).toBeGreaterThan(antes);
    expect(lidos("academico")).toBeGreaterThan(1);
    expect(lidos("pendencias")).toBeGreaterThan(1);
  });

  it("trocar de safra refaz as consultas daquele recorte", async () => {
    await abrir();
    await irPara("2024");
    expect(rpcMock).toHaveBeenCalledWith("carteira_efetividade_ler",
      { p_bloco: "academico", p_ano: "2024", p_semestre: null });
    expect(rpcMock).toHaveBeenCalledWith("carteira_efetividade_ler",
      { p_bloco: "pendencias", p_ano: "2024", p_semestre: null });
  });

  it("a tela diz de quando é o número, com dia e hora", async () => {
    await abrir();
    // NÃO asserir a hora renderizada: esta máquina é BRT e o CI é UTC, e o
    // mesmo instante sai com hora diferente nos dois. Asserta a FORMA.
    expect(txt(screen.getByText(/Dados atualizados em/)))
      .toMatch(/^Dados atualizados em \d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}/);
  });

  it("não se apresenta como dado ao vivo", async () => {
    await abrir();
    expect(screen.queryByText(/lid[oa]s? ao vivo/i)).toBeNull();
  });

  it("quando houve movimentação depois, diz “Atualização pendente”", async () => {
    responder({ __blocos: { situacoes: { ...SITUACOES, snapshot: PENDENTE } } });
    await abrir();
    expect(screen.getByText(/Atualização pendente/)).toBeTruthy();
  });

  it("fotografia em dia NÃO mostra “Atualização pendente”", async () => {
    await abrir();
    expect(screen.queryByText(/Atualização pendente/)).toBeNull();
  });

  it("o botão NUNCA roda a consulta pesada dentro da requisição", async () => {
    responder({ __blocos: { situacoes: { ...SITUACOES, snapshot: PENDENTE } } });
    await abrir();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Atualizar dados/ })); });
    const nomes = rpcMock.mock.calls.map((c) => c[0]);
    expect(nomes).not.toContain("carteira_efetividade_snapshot_recalcular");
    expect(nomes).not.toContain("carteira_efetividade_atender_pedidos");
    expect(nomes).not.toContain("carteira_safra_situacoes");
  });

  it("o botão relê PRIMEIRO e só pede se continuar desatualizada", async () => {
    responder({ __blocos: { situacoes: { ...SITUACOES, snapshot: PENDENTE } } });
    await abrir();
    const antes = lidos("situacoes");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Atualizar dados/ })); });
    // releu
    expect(lidos("situacoes")).toBeGreaterThan(antes);
    // e pediu, porque a releitura veio desatualizada
    expect(rpcMock).toHaveBeenCalledWith("carteira_efetividade_pedir_atualizacao",
      { p_recorte: "2026/1" });
  });

  it("fotografia em dia: o botão relê e NÃO pede nada", async () => {
    await abrir();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Atualizar dados/ })); });
    const nomes = rpcMock.mock.calls.map((c) => c[0]);
    expect(nomes).not.toContain("carteira_efetividade_pedir_atualizacao");
  });

  it("não há polling: sem interação, nada é consultado de novo", async () => {
    await abrir();
    const antes = rpcMock.mock.calls.length;
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(rpcMock.mock.calls.length).toBe(antes);
  });
});

describe("Efetividade — 2024 e 2025 por ano", () => {
  it("2026 continua com o seletor de semestre", async () => {
    await abrir();
    expect(screen.getByRole("button", { name: "1º semestre" })).toBeTruthy();
    expect(screen.getAllByText("2026/1").length).toBeGreaterThanOrEqual(1);
  });

  it("2024 esconde o semestre e mostra o ano inteiro", async () => {
    await abrir();
    await irPara("2024");
    expect(screen.queryByRole("button", { name: "1º semestre" })).toBeNull();
    expect(screen.getByText("· Cobertura histórica")).toBeTruthy();
    expect(screen.getByText(/os dois semestres são lidos juntos/)).toBeTruthy();
  });

  it("volta para 2026 e o semestre reaparece", async () => {
    await abrir();
    await irPara("2024");
    await irPara("2026");
    expect(screen.getByRole("button", { name: "2º semestre" })).toBeTruthy();
  });

  it("falha na safra não derruba a página: o aviso sobe e o resto fica", async () => {
    responder({ __blocos: { situacoes: { __erro: { message: "statement timeout" } } } });
    await abrir();
    expect(screen.getByText(/Não foi possível carregar as seis linhas: statement timeout/)).toBeTruthy();
    expect(screen.getByText("Casos ainda pendentes")).toBeTruthy();
  });
});

// O alternador de visão existe SÓ em 2026/2: é a safra em curso. O conteúdo da
// visão por competência tem teste próprio em
// src/components/EfetividadeCompetencias.test.jsx.
describe("Efetividade — 2026/2 preservada", () => {
  it("2026/1 não oferece a visão por competência", async () => {
    await abrir();
    expect(screen.queryByRole("button", { name: "Por competência" })).toBeNull();
  });

  it("2026/2 oferece Consolidado e Por competência, começando no consolidado", async () => {
    await abrir();
    await ir2026_2();
    expect(screen.getByRole("button", { name: "Consolidado" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Por competência" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("2024 esconde o alternador junto com o semestre", async () => {
    await abrir();
    await ir2026_2();
    await irPara("2024");
    expect(screen.queryByRole("button", { name: "Por competência" })).toBeNull();
  });

  it("a metodologia continua acessível na visão por competência", async () => {
    await abrir();
    await ir2026_2();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Por competência" })); });
    expect(screen.getByRole("button", { name: /Ver metodologia/ })).toBeTruthy();
  });

  it("declara a base: mensalidades com acordo, de quantas da carteira", async () => {
    await abrir();
    await ir2026_2();
    expect(screen.getByText("Mensalidades com acordo: 268 de 2.522 da carteira")).toBeTruthy();
    expect(screen.queryByText("268 títulos negociados")).toBeNull();
  });

  it("os dois números vêm das consultas, não do código", async () => {
    responder({
      carteira_2026_2_negociacoes: { ...NEGOCIACOES, total: { ...NEGOCIACOES.total, titulos: 401 } },
      carteira_2026_2_contexto: { ...CONTEXTO, carteira_titulos: 3111 },
    });
    await abrir();
    await ir2026_2();
    expect(screen.getByText("Mensalidades com acordo: 401 de 3.111 da carteira")).toBeTruthy();
  });

  it("sem o contexto carregado, some a base em vez de mostrar 'de 0'", async () => {
    responder({ carteira_2026_2_contexto: null });
    await abrir();
    await ir2026_2();
    expect(screen.getByText("Mensalidades com acordo: 268")).toBeTruthy();
    expect(screen.queryByText(/de 0 da carteira/)).toBeNull();
  });

  it("os quatro indicadores de 2026/2 seguem os da safra vigente, intocados", async () => {
    await abrir();
    await ir2026_2();
    const texto = txt(document.body);
    expect(texto).toContain("Valor negociado");
    expect(texto).toContain("Alunos negociados");
    expect(texto).toContain("Saldo negociado");
  });
});

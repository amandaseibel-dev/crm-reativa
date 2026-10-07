// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";

// O que se prova aqui é o ENQUADRAMENTO de 2024/2025: ano inteiro (sem seletor
// de semestre), saldo em aberto da régua ajustada, o balde 166 em linha própria
// e a composição por curso. Nenhuma conta acontece no front — os valores vêm
// prontos da RPC, então o dublê devolve exatamente o payload de produção.
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

const CONSOLIDADA = {
  base: { valor: 21752304.72, cpfs: 5253, titulos: 14988, congelada_em: "2026-09-11" },
  faixas: { efetividade: 11218629.14, inadimplencia: 9742154.54, em_validacao: 965660.93, academico: 38940.39 },
  recuperacao: { total: 6510891.25 },
  gerado_em: "2026-09-17",
};

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation((nome) => {
    if (nome === "carteira_2026_1_indicadores") return Promise.resolve({ data: CONSOLIDADA });
    if (nome === "carteira_saldo_historico_por_ano") return Promise.resolve({ data: POR_ANO });
    return Promise.resolve({ data: null });
  });
});
afterEach(() => cleanup());

async function abrir() {
  await act(async () => { render(<CarteiraEfetividade />); });
}

// O card "Status acadêmico por safra" repete, na mesma página, os rótulos das
// categorias e os nomes das safras. Estas asserções são sobre o bloco "Alunos
// por status" das seis linhas, então a busca passa a ser DENTRO dele.
function blocoSeisLinhas() {
  return screen.getByText("As seis linhas da safra").closest("section");
}

async function irPara(ano) {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: ano })); });
}

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
    // "2024" aparece no botão do ano e no rótulo do período; aqui interessa o rótulo.
    expect(screen.getByText((_, el) => el?.tagName === "STRONG" && el.textContent === "2024")).toBeTruthy();
    expect(screen.getByText("· Cobertura histórica")).toBeTruthy();
    expect(screen.getByText(/os dois semestres são lidos juntos/)).toBeTruthy();
  });

  it("2024 mostra o saldo em aberto ajustado, os alunos e o balde 166", async () => {
    await abrir();
    await irPara("2024");
    expect(screen.getByText("Saldo em aberto")).toBeTruthy();
    expect(screen.getByText("R$ 3,71 mi")).toBeTruthy();
    expect(screen.getByText("6.411 mensalidades")).toBeTruthy();
    expect(screen.getByText("1.991 alunos")).toBeTruthy();
    expect(screen.getByText("Negociado direto com a Ulbra, a confirmar")).toBeTruthy();
    expect(screen.getByText("R$ 613.246,31")).toBeTruthy();
  });

  it("2024 troca o perfil acadêmico pela composição por curso", async () => {
    await abrir();
    await irPara("2024");
    expect(screen.getByRole("heading", { name: "Saldo em aberto por curso" })).toBeTruthy();
    expect(screen.getByText("Graduação Presencial")).toBeTruthy();
    expect(screen.getByText("Pós-Graduação (Lato Sensu)")).toBeTruthy();
    expect(screen.getByText(/486 mensalidades/)).toBeTruthy();
  });

  it("2025 tem números próprios", async () => {
    await abrir();
    await irPara("2025");
    expect(screen.getByText("R$ 6,31 mi")).toBeTruthy();
    expect(screen.getByText("2.967 alunos")).toBeTruthy();
    expect(screen.getByText("10.710 mensalidades")).toBeTruthy();
  });

  it("volta para 2026 e o semestre reaparece", async () => {
    await abrir();
    await irPara("2024");
    await irPara("2026");
    expect(screen.getByRole("button", { name: "2º semestre" })).toBeTruthy();
    expect(screen.getAllByText("2026/1").length).toBeGreaterThanOrEqual(1);
  });
});

// O alternador de visão existe SÓ em 2026/2: é a safra em curso. O conteúdo da
// visão por competência tem teste próprio em
// src/components/EfetividadeCompetencias.test.jsx.
describe("Efetividade — alternador de visão de 2026/2", () => {
  async function ir2026_2() {
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "2º semestre" })); });
  }

  it("2026/1 não oferece a visão por borderô", async () => {
    await abrir();
    expect(screen.queryByRole("button", { name: "Por competência" })).toBeNull();
  });

  it("2026/2 oferece Consolidado e Por competência, começando no consolidado", async () => {
    await abrir();
    await ir2026_2();
    const consolidado = screen.getByRole("button", { name: "Consolidado" });
    expect(consolidado.getAttribute("aria-pressed")).toBe("true");
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
});

// ---------------------------------------------------------------------------
// NOMENCLATURA DO CONSOLIDADO
//
// "268 títulos negociados" era verdade e ainda assim confundia: a outra visão
// da mesma tela conta 2.522 mensalidades, e nada dizia que uma é recorte da
// outra (o Consolidado tem um INNER JOIN em acordo; é subconjunto perfeito).
// O que estes testes travam é que a base apareça, e que ela venha da CONSULTA
// -- numero fixo aqui passaria despercebido para sempre.
// ---------------------------------------------------------------------------
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

describe("Efetividade — nomenclatura do Consolidado em 2026/2", () => {
  function comConsolidado(contexto = CONTEXTO) {
    rpcMock.mockImplementation((nome) => {
      if (nome === "carteira_2026_1_indicadores") return Promise.resolve({ data: CONSOLIDADA });
      if (nome === "carteira_saldo_historico_por_ano") return Promise.resolve({ data: POR_ANO });
      if (nome === "carteira_2026_2_negociacoes") return Promise.resolve({ data: NEGOCIACOES });
      if (nome === "carteira_2026_2_contexto") return Promise.resolve({ data: contexto });
      return Promise.resolve({ data: null });
    });
  }
  async function ir2026_2() {
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "2º semestre" })); });
  }

  it("declara a base: mensalidades com acordo, de quantas da carteira", async () => {
    comConsolidado();
    await abrir();
    await ir2026_2();
    expect(screen.getByText("Mensalidades com acordo: 268 de 2.522 da carteira")).toBeTruthy();
    // e o texto antigo, que não dizia de quantas, não volta
    expect(screen.queryByText("268 títulos negociados")).toBeNull();
  });

  it("os dois números vêm das consultas, não do código", async () => {
    comConsolidado({ ...CONTEXTO, carteira_titulos: 3111 });
    rpcMock.mockImplementation(((anterior) => (nome) => {
      if (nome === "carteira_2026_2_negociacoes") {
        return Promise.resolve({ data: { ...NEGOCIACOES, total: { ...NEGOCIACOES.total, titulos: 401 } } });
      }
      return anterior(nome);
    })(rpcMock.getMockImplementation()));
    await abrir();
    await ir2026_2();
    expect(screen.getByText("Mensalidades com acordo: 401 de 3.111 da carteira")).toBeTruthy();
  });

  it("sem o contexto carregado, some a base em vez de mostrar 'de 0'", async () => {
    comConsolidado(null);
    await abrir();
    await ir2026_2();
    expect(screen.getByText("Mensalidades com acordo: 268")).toBeTruthy();
    expect(screen.queryByText(/de 0 da carteira/)).toBeNull();
  });
});

// Desde 06/10/2026 os indicadores de 2026/1 leem AO VIVO, e aí aparece título em
// FORA_DA_BASE — cobrança encerrada administrativamente, que antes não entrava em
// faixa nenhuma e fazia as barras somarem 99,48% da base sendo declaradas 100%.
// Por decisão da gestão esse valor entra na faixa `academico`, mesma regra da
// linha "Cancelado" da visão das seis linhas. Os números abaixo são os MEDIDOS em
// produção em 06/10: academico 39.462,21 de ajuste + 112.595,16 de encerrado.
const VIVO_2026_1 = {
  base: { valor: 21710447.29, cpfs: 5250, titulos: 14979, congelada_em: "2026-09-11" },
  faixas: {
    efetividade: 11615720.75,
    inadimplencia: 9134866.22,
    em_validacao: 807802.95,
    academico: 152057.37,
  },
  academico_detalhe: {
    ajuste_academico: 39462.21,
    encerrado_administrativo: 112595.16,
    titulos_encerrados: 15,
  },
  recuperacao: { total: 6896336.45 },
  gerado_em: "2026-10-06",
  fonte: "ao vivo",
};

describe("Efetividade — 2026/1 ao vivo, com as quatro faixas fechando", () => {
  function comVivo(dados = VIVO_2026_1) {
    rpcMock.mockReset();
    rpcMock.mockImplementation((nome) => {
      if (nome === "carteira_2026_1_indicadores") return Promise.resolve({ data: dados });
      if (nome === "carteira_saldo_historico_por_ano") return Promise.resolve({ data: POR_ANO });
      return Promise.resolve({ data: null });
    });
  }

  // A invariante é a razão de ser desta mudança, então ela é asserida sobre os
  // mesmos números que a tela recebe — não sobre o texto renderizado.
  it("as quatro faixas somam exatamente base.valor", () => {
    const f = VIVO_2026_1.faixas;
    const soma = f.efetividade + f.inadimplencia + f.em_validacao + f.academico;
    expect(Number(soma.toFixed(2))).toBe(VIVO_2026_1.base.valor);
  });

  it("a faixa academico é a soma do ajuste acadêmico e do encerrado administrativo", () => {
    const d = VIVO_2026_1.academico_detalhe;
    expect(Number((d.ajuste_academico + d.encerrado_administrativo).toFixed(2)))
      .toBe(VIVO_2026_1.faixas.academico);
  });

  it("a barra declara as duas coisas que a faixa carrega", async () => {
    comVivo();
    await abrir();
    expect(screen.getByText("Encerrado / ajuste acadêmico")).toBeTruthy();
    expect(screen.queryByText("Ajuste acadêmico")).toBeNull();
  });

  it("não sobra ressalva técnica no rodapé", async () => {
    comVivo();
    await abrir();
    expect(screen.queryByText(/fora das quatro faixas/)).toBeNull();
    expect(screen.queryByText(/FORA_DA_BASE/)).toBeNull();
    expect(screen.getByText(/congelada em/)).toBeTruthy();
  });

  it("RPC antiga, sem academico_detalhe, não quebra a tela", async () => {
    comVivo({ ...VIVO_2026_1, academico_detalhe: undefined });
    await abrir();
    expect(screen.getByText("Encerrado / ajuste acadêmico")).toBeTruthy();
  });
});

// Categorias REAIS de producao (carteira_academico_perfil), medidas em
// 06/10/2026. So os rotulos e as contagens -- e o que a tela mostra.
const PERFIL = {
  "2024": { importacao: { atualizado_em: "2026-08-04T15:19:51Z", situacoes: [
    { situacao: "(sem situação importada)", alunos: 806 }, { situacao: "Término do Contrato", alunos: 382 },
    { situacao: "Desvinculado", alunos: 245 }, { situacao: "Formado", alunos: 152 }] } },
  "2025": { importacao: { atualizado_em: "2026-08-04T15:20:56Z", situacoes: [
    { situacao: "Término do Contrato", alunos: 1692 }, { situacao: "Cancelado", alunos: 441 },
    { situacao: "Trancado", alunos: 346 }, { situacao: "Formado", alunos: 233 }] } },
  "2026": { importacao: { atualizado_em: "2026-08-04T15:21:17Z", situacoes: [
    { situacao: "Aguardando Matrícula", alunos: 1416 }, { situacao: "Cancelado", alunos: 320 }] } },
};
const SITUACOES = {
  natureza: "CARTEIRA_CONSOLIDADA", fonte: "ao vivo", gerado_em: "2026-10-06",
  situacoes: { entrou: { alunos: 9, titulos: 9, valor: 1000 }, pago: { alunos: 1, titulos: 1, valor: 400 },
    negociado: { alunos: 1, titulos: 1, valor: 0 }, cancelado: { alunos: 1, titulos: 1, valor: 0 },
    em_aberto: { alunos: 1, titulos: 1, valor: 500 }, pendente: { alunos: 1, titulos: 1, valor: 100 } },
  pendente_detalhe: {}, conferencia: { fecha: true, entrou: 1000, soma_das_linhas: 1000, diferenca: 0 },
};

function comPerfil(ano) {
  return (nome, args) => {
    if (nome === "carteira_2026_1_indicadores") return Promise.resolve({ data: CONSOLIDADA });
    if (nome === "carteira_saldo_historico_por_ano") return Promise.resolve({ data: POR_ANO });
    if (nome === "carteira_safra_situacoes") return Promise.resolve({ data: SITUACOES });
    if (nome === "carteira_academico_perfil_ler") return Promise.resolve({ data: PERFIL[args?.p_ano ?? ano] ?? null });
    return Promise.resolve({ data: null });
  };
}

describe("Efetividade — Alunos por status em toda safra", () => {
  it("2026/1 mostra o bloco UMA vez — a lista acadêmica antiga saiu da página", async () => {
    rpcMock.mockImplementation(comPerfil("2026"));
    await abrir();
    expect(screen.getAllByText("Alunos por status")).toHaveLength(1);
    // O titulo do bloco legado nao existe mais em lugar nenhum.
    expect(screen.queryByText("Perfil dos alunos")).toBeNull();
    expect(screen.queryByText(/Informação acadêmica não disponível/)).toBeNull();
  });

  it("2024 mostra Alunos por status com as categorias da base", async () => {
    rpcMock.mockImplementation(comPerfil("2024"));
    await abrir();
    await irPara("2024");
    expect(screen.getAllByText("Alunos por status")).toHaveLength(1);
    expect(within(blocoSeisLinhas()).getByText("Desvinculado")).toBeTruthy();
    expect(within(blocoSeisLinhas()).getByText("Formado")).toBeTruthy();
  });

  it("2025 mostra Alunos por status com as categorias da base", async () => {
    rpcMock.mockImplementation(comPerfil("2025"));
    await abrir();
    await irPara("2025");
    expect(screen.getAllByText("Alunos por status")).toHaveLength(1);
    expect(within(blocoSeisLinhas()).getByText("Término do Contrato")).toBeTruthy();
  });

  it("2024 e 2025 mantêm o saldo por curso, que não é duplicata de nada", async () => {
    rpcMock.mockImplementation(comPerfil("2024"));
    await abrir();
    await irPara("2024");
    expect(screen.getByText("Saldo em aberto por curso")).toBeTruthy();
  });

  it("se a consulta acadêmica falhar, a tela DIZ — não some em silêncio", async () => {
    rpcMock.mockImplementation((nome) => {
      if (nome === "carteira_2026_1_indicadores") return Promise.resolve({ data: CONSOLIDADA });
      if (nome === "carteira_saldo_historico_por_ano") return Promise.resolve({ data: POR_ANO });
      if (nome === "carteira_safra_situacoes") return Promise.resolve({ data: SITUACOES });
      if (nome === "carteira_academico_perfil_ler")
        return Promise.resolve({ error: { message: "canceling statement due to statement timeout" } });
      return Promise.resolve({ data: null });
    });
    await abrir();
    expect(screen.getByText(/Alunos por status não carregou/)).toBeTruthy();
    expect(within(blocoSeisLinhas()).getByText(/statement timeout/)).toBeTruthy();
    // as seis linhas continuam de pe
    expect(screen.getByText("As seis linhas da safra")).toBeTruthy();
  });
});

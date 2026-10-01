// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

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

// 2026/2 precisa responder para a Situação da carteira existir na tela: sem
// estes dois a tela cai em "Sem dados para 2026/2" e não dá para provar qual é
// a visão padrão. Números inventados — o que se prova aqui é enquadramento.
const VIGENTE = {
  total: { negociado: 16000, recebido: 9000, saldo: 7000, cpfs: 10, acordos: 11, titulos: 12 },
  estados: [
    { estado: "Quitado", negociado: 6000, recebido: 6000, saldo: 0, cpfs: 4, acordos: 4, titulos: 4 },
    { estado: "Regular", negociado: 5000, recebido: 2000, saldo: 3000, cpfs: 3, acordos: 3, titulos: 4 },
  ],
};
const CONTEXTO_2026_2 = {
  remessas: 4, carteira_cpfs: 118, carteira_titulos: 150, carteira_valor: 161000,
  primeira_remessa: "2026-07-06", ultima_remessa: "2026-09-09",
};

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation((nome) => {
    if (nome === "carteira_2026_1_indicadores") return Promise.resolve({ data: CONSOLIDADA });
    if (nome === "carteira_saldo_historico_por_ano") return Promise.resolve({ data: POR_ANO });
    if (nome === "carteira_2026_2_negociacoes") return Promise.resolve({ data: VIGENTE });
    if (nome === "carteira_2026_2_contexto") return Promise.resolve({ data: CONTEXTO_2026_2 });
    return Promise.resolve({ data: null });
  });
});
afterEach(() => cleanup());

async function abrir() {
  await act(async () => { render(<CarteiraEfetividade />); });
}

async function irPara(ano) {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: ano })); });
}

describe("Efetividade — 2024 e 2025 por ano", () => {
  it("2026 continua com o seletor de semestre", async () => {
    await abrir();
    expect(screen.getByRole("button", { name: "1º semestre" })).toBeTruthy();
    expect(screen.getByText("2026/1")).toBeTruthy();
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
    expect(screen.getByText("2026/1")).toBeTruthy();
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

  it("2026/2 oferece as três visões, começando na Situação da carteira", async () => {
    await abrir();
    await ir2026_2();
    const consolidado = screen.getByRole("button", { name: "Situação da carteira" });
    expect(consolidado.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Por competência" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Resumo por vencimento" }).getAttribute("aria-pressed")).toBe("false");
  });

  // Quem abre a Efetividade tem que cair na Situação da carteira, sempre. Esta
  // é a visão que a diretoria lê primeiro, e trocar o padrão sem querer (um
  // useState novo, um parâmetro de URL, uma preferência salva) é o tipo de
  // mudança que passa despercebida na revisão. O teste trava o padrão pelo que
  // aparece NA TELA, não pelo nome do estado interno.
  it("ao abrir, a visão é a Situação da carteira — não as mensais", async () => {
    await abrir();
    await ir2026_2();
    // De propósito pelo HEADING, não pelo texto solto: depois do renome o
    // rótulo "Situação da carteira" também existe como BOTÃO do seletor, e um
    // getByText passaria mesmo com a visão errada aberta.
    expect(screen.getByRole("heading", { name: /Situação da carteira/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Situação da carteira" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("POR MÊS DE VENCIMENTO")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Por competência/i })).toBeNull();
  });

  it("o padrão da Situação da carteira vale em 2026/1 também, sem seletor de visão", async () => {
    await abrir();
    expect(screen.getByRole("heading", { name: /Situação da carteira/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resumo por vencimento" })).toBeNull();
  });

  it("trocar de visão pelo seletor continua funcionando nos dois sentidos", async () => {
    await abrir();
    await ir2026_2();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resumo por vencimento" })); });
    expect(screen.getByRole("button", { name: "Resumo por vencimento" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("heading", { name: /Situação da carteira/i })).toBeNull();
    // e volta
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Situação da carteira" })); });
    expect(screen.getByRole("heading", { name: /Situação da carteira/i })).toBeTruthy();
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


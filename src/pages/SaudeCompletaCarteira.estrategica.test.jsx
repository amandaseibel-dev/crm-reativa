// @vitest-environment jsdom
//
// CAMADA ESTRATÉGICA DA SAÚDE COMPLETA DA CARTEIRA.
//
// O risco desta PR é um só: a tela passar a dizer coisas que a base não disse.
// São blocos de LEITURA montados em cima dos mesmos dados -- nenhuma RPC nova,
// nenhum cálculo de negócio novo. Este arquivo existe para prender exatamente
// isso, e por isso a fixture usa números redondos: 750.000 em 1.000.000 tem de
// aparecer como 75.0%, e qualquer deriva vira falha aqui.
//
// O que está preso:
//  1) nenhuma RPC fora da lista que a tela já chamava;
//  2) os totais do Resumo executivo são os MESMOS dos cards;
//  3) o acumulado (Pareto) fecha em 100% e o núcleo é contado pelo limiar;
//  4) Prioridades ordena por gravidade e depois por contagem, e esconde zeros;
//  5) a participação por estabelecimento/operador soma 100% na linha de total,
//     e o TOTAL DA CARTEIRA vem de `totais`, não da soma das linhas;
//  6) o semáforo respeita LIMIARES e não é mais binário;
//  7) os filtros atuais continuam indo para todas as RPCs.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import SaudeCompletaCarteira from "./SaudeCompletaCarteira";

vi.mock("../utils/exportarSaudeCarteira", () => ({ exportarSaudeCarteira: vi.fn() }));

// ── FIXTURE ────────────────────────────────────────────────────────────────
// Números escolhidos para que toda porcentagem esperada seja exata.
const TOTAIS = {
  casos_ativos: 1000,
  cpfs_unicos: 800,
  saldo_vencido: 1000000,   // 50% de saldo_total
  saldo_total: 2000000,
  nunca_acionados: 120,
  sem_acionamento_limite: 300,
  pct_sem_acionamento: 40,  // > 30 => risco
  retornos_vencidos: 0,     // zerado: NÃO deve virar prioridade
  sem_telefone: 400,
  sem_responsavel: 0,       // zerado
  criticos: 10,
  urgentes: 7,
  acordos_em_dia: 90,
  acordos_vencidos: 30,
  acordos_quebrados: 4,
  acordos_em_dia_sem_acompanhamento: 5,
  casos_revisao: 0,         // zerado
  fidelizacao_expira_hoje: 2,
  casos_livres: 0,          // zerado
};

// 750.000 + 250.000 = 1.000.000 = totais.saldo_vencido  => 75% e 25%
const ESTABS = [
  { estabelecimento: "ULBRA CANOAS", casos_ativos: 700, cpfs_unicos: 560, saldo_vencido: 750000, saldo_total: 1500000,
    nunca_acionados: 90, sem_acionamento_limite: 220, pct_sem_acionamento: 40, sem_ac_7: 1, sem_ac_15: 2, sem_ac_30: 3,
    retornos_vencidos: 0, sem_telefone: 300, sem_responsavel: 0, criticos: 8, urgentes: 5,
    acordos_em_dia: 60, acordos_vencidos: 20, acordos_quebrados: 3, casos_revisao: 0 },
  { estabelecimento: "ULBRA TORRES", casos_ativos: 300, cpfs_unicos: 240, saldo_vencido: 250000, saldo_total: 500000,
    nunca_acionados: 30, sem_acionamento_limite: 80, pct_sem_acionamento: 10, sem_ac_7: 1, sem_ac_15: 1, sem_ac_30: 1,
    retornos_vencidos: 0, sem_telefone: 100, sem_responsavel: 0, criticos: 2, urgentes: 2,
    acordos_em_dia: 30, acordos_vencidos: 10, acordos_quebrados: 1, casos_revisao: 0 },
];

// 600.000 + 400.000 = 1.000.000 => 60% e 40%
const OPERADORES = [
  { operador_email: "ana@x.com", casos_ativos: 600, cpfs_unicos: 480, saldo_vencido: 600000, saldo_total: 1200000,
    nunca_acionados: 70, sem_acionamento_limite: 200, pct_sem_acionamento: 50, retornos_vencidos: 0,
    sem_telefone: 240, criticos: 6, urgentes: 4, acordos_em_dia: 50, acordos_vencidos: 18 },
  { operador_email: "bia@x.com", casos_ativos: 400, cpfs_unicos: 320, saldo_vencido: 400000, saldo_total: 800000,
    nunca_acionados: 50, sem_acionamento_limite: 100, pct_sem_acionamento: 10, retornos_vencidos: 0,
    sem_telefone: 160, criticos: 4, urgentes: 3, acordos_em_dia: 40, acordos_vencidos: 12 },
];

const ORIGEM = {
  total: 1000000, vencido: 700000, a_vencer: 300000,
  acordo_total: 600000, acordo_vencido: 400000, acordo_a_vencer: 200000, acordo_alunos: 300,
  mensalidade_total: 400000, mensalidade_vencido: 300000, mensalidade_a_vencer: 100000, mensalidade_alunos: 500,
  calculado_em: "2026-10-02T09:00:00.000Z",
};

// Acumulado esperado: 50 → 80 → 95 → 100. Com pareto_pct = 80, núcleo = 2 cursos.
const POR_CURSO = {
  total: 1000000,
  por_curso: [
    { curso: "MEDICINA", casos: 40, saldo: 500000, ticket_medio: 12500, pct_valor: 50 },
    { curso: "DIREITO", casos: 120, saldo: 300000, ticket_medio: 2500, pct_valor: 30 },
    { curso: "ENFERMAGEM", casos: 60, saldo: 150000, ticket_medio: 2500, pct_valor: 15 },
    { curso: "ADMINISTRACAO", casos: 25, saldo: 50000, ticket_medio: 2000, pct_valor: 5 },
  ],
};

const PANORAMA = {
  total: { cpfs: 800, titulos: 3000, valor: 2000000 },
  por_semestre: [{ semestre: "2026/1", cpfs: 800, valor: 2000000, pct_valor: 100 }],
  acordo_por_ano: [{ ano: 2026, cpfs: 300, parcelas: 900, valor: 600000, pct_valor: 60, vencido: true }],
  por_faixa: [
    { faixa: "Acima de 50 mil", cpfs: 100, pct_cpfs: 12.5, valor: 1200000, pct_valor: 60 },
    { faixa: "Até 5 mil", cpfs: 700, pct_cpfs: 87.5, valor: 800000, pct_valor: 40 },
  ],
  por_tipo: [
    { tipo: "ACORDO", titulos: 900, cpfs: 300, valor: 600000, pct_valor: 60 },
    { tipo: "MENSALIDADE", titulos: 2100, cpfs: 500, valor: 400000, pct_valor: 40 },
  ],
};

// 400 (risco) · 60 (risco) · 10 (âmbar) · 0 (ok) => total 470
const QUALIDADE = { sem_email: 10, sem_telefone: 400, sem_responsavel: 0, sem_cpf: 60 };

const RESUMO = {
  atualizado_em: "2026-10-02T09:00:00.000Z",
  escopo: { is_gestao: true, operador: null },
  totais: TOTAIS,
  estabelecimentos: ESTABS,
  operadores: OPERADORES,
  saldo_por_origem: ORIGEM,
  matriz_faixa_atraso: [],
  matriz_tempo_sem_acionamento: [],
};

const d = vi.hoisted(() => ({ chamadas: [], filtrosVistos: [] }));

vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (fn, args) => {
      d.chamadas.push(fn);
      if (args?.p_filtros) d.filtrosVistos.push([fn, args.p_filtros]);
      if (fn === "usuario_e_gestao") return Promise.resolve({ data: true, error: null });
      if (fn === "base_data_de_corte") return Promise.resolve({ data: null, error: null });
      if (fn === "saude_carteira_panorama") return Promise.resolve({ data: PANORAMA, error: null });
      if (fn === "saude_carteira_por_curso") return Promise.resolve({ data: POR_CURSO, error: null });
      if (fn === "saude_carteira_qualidade") return Promise.resolve({ data: { qualidade: QUALIDADE }, error: null });
      if (fn === "saude_carteira_atualizar") return Promise.resolve({ data: { atualizado_em: RESUMO.atualizado_em }, error: null });
      if (fn === "saude_carteira_resumo") {
        const r = { data: RESUMO, error: null };
        return { ...Promise.resolve(r), abortSignal: () => Promise.resolve(r) };
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

// POR QUE AS PORCENTAGENS ESPERADAS USAM PONTO E NÃO VÍRGULA.
//
// O helper `pct` da tela é `toFixed(1)`, que é formatação de JS, não pt-BR:
// sai "50.0%". Os valores em dinheiro passam por Intl e saem "R$ 1.000.000,00".
// A tela já mistura os dois separadores hoje, em Panorama e Por curso, desde
// antes desta PR. Este arquivo prende o comportamento REAL, não o desejado --
// trocar `pct` por Intl muda número que já está em produção e é assunto de
// outra PR. Se alguém arrumar `pct`, estes testes falham de propósito.

// O espaço depois de "R$" é NBSP no Intl pt-BR; normalizar evita falha boba.
const corpo = () => document.body.textContent.replace(/\u00a0/g, " ");
const botao = () => screen.getByRole("button", { name: /Recalcular indicadores|Atualizar indicadores|Recalculando|Atualizando/ });

// A Secao renderiza <div><div><h2/>extra</div>{children}</div>: subir dois
// níveis a partir do h2 devolve a seção inteira, que é o escopo de consulta.
const secao = (titulo) => screen.getByText(titulo, { selector: "h2" }).parentElement.parentElement;

const abrirEEsperar = async () => {
  render(<SaudeCompletaCarteira />);
  await waitFor(() => expect(d.chamadas).toContain("usuario_e_gestao"));
  fireEvent.click(botao());
  await waitFor(() => expect(screen.getByText(/base atualizada em/)).toBeTruthy());
  await waitFor(() => expect(screen.getByText("Prioridades de gestão", { selector: "h2" })).toBeTruthy());
};

describe("Saúde Completa da Carteira — camada estratégica", () => {
  beforeEach(() => { d.chamadas = []; d.filtrosVistos = []; });
  afterEach(cleanup);

  // ── 1. SEM RPC NOVA, SEM BANCO ──────────────────────────────────────────
  it("não chama nenhuma RPC além das que a tela já usava", async () => {
    await abrirEEsperar();
    const PERMITIDAS = new Set([
      "usuario_e_gestao", "base_data_de_corte", "saude_carteira_panorama",
      "saude_carteira_por_curso", "saude_carteira_qualidade",
      "saude_carteira_atualizar", "saude_carteira_resumo",
    ]);
    const intrusas = [...new Set(d.chamadas)].filter((fn) => !PERMITIDAS.has(fn));
    expect(intrusas).toEqual([]);
  });

  // ── 2. RESUMO EXECUTIVO REPETE, NÃO RECALCULA ───────────────────────────
  it("o Resumo executivo mostra os MESMOS totais dos cards", async () => {
    await abrirEEsperar();
    const t = corpo();
    // saldo_total e saldo_vencido exatamente como a base mandou.
    expect(t).toContain("R$ 2.000.000,00");
    expect(t).toContain("R$ 1.000.000,00");
    // 1.000.000 / 2.000.000 = 50.0% vencido.
    expect(t).toContain("50.0% do total");
    // casos e alunos sem arredondamento.
    expect(t).toContain("1.000 casos · 800 alunos");
    // nunca acionados repetido do card, não recontado.
    expect(t).toContain("120 nunca foram acionados");
    // 600.000 / 1.000.000 em acordo = 60.0%.
    expect(t).toContain("60.0%");
  });

  it("a Concentração do resumo aponta o maior curso com o % que a RPC deu", async () => {
    await abrirEEsperar();
    // MEDICINA é 50% do valor; o ticket é o da própria RPC, não calculado aqui.
    expect(corpo()).toContain("do valor está em MEDICINA, com 40 alunos e ticket médio de R$ 12.500,00");
  });

  it("Confiança no dado soma as contagens de qualidade sem alterá-las", async () => {
    await abrirEEsperar();
    // 10 + 400 + 0 + 60 = 470
    expect(secao("Qualidade da carteira").textContent).toContain("470 registros com defeito");
  });

  // ── 3. ONDE ESTÁ O DINHEIRO: PARETO ─────────────────────────────────────
  it("o acumulado fecha em 100% e o núcleo é contado pelo limiar de Pareto", async () => {
    await abrirEEsperar();
    const s = secao("Onde está o dinheiro").textContent.replace(/\u00a0/g, " ");
    // 50 → 80 → 95 → 100, na ordem de saldo.
    expect(s).toContain("50.0%");
    expect(s).toContain("80.0%");
    expect(s).toContain("95.0%");
    expect(s).toContain("100.0%");
    // MEDICINA (50) + DIREITO (30) alcançam 80% => núcleo de 2 cursos de 4.
    expect(s).toContain("2 cursos");
    expect(s).toContain("de 4 cursos na carteira");
  });

  it("o bloco negociado x não negociado repete os valores de saldo_por_origem", async () => {
    await abrirEEsperar();
    const s = secao("Onde está o dinheiro").textContent.replace(/\u00a0/g, " ");
    expect(s).toContain("em acordo (R$ 600.000,00)");
    expect(s).toContain("R$ 400.000,00 ainda sem negociação");
  });

  // ── 4. PRIORIDADES DE GESTÃO ────────────────────────────────────────────
  it("ordena por gravidade e depois por contagem, e esconde o que está zerado", async () => {
    await abrirEEsperar();
    const linhas = [...secao("Prioridades de gestão").querySelectorAll("button")]
      .map((b) => b.textContent);

    // gravidade 3 primeiro (por contagem desc), depois 2, depois 1.
    const titulos = linhas.map((l) => {
      const m = l.match(/(Nunca acionados|Acordos vencidos|Fidelização expira hoje|Sem acionamento \(acima do limite\)|Críticos|Acordos em dia sem acompanhamento|Sem telefone|Retornos vencidos|Casos para revisão|Casos livres|Sem responsável)/);
      return m ? m[1] : l;
    });
    expect(titulos).toEqual([
      "Nunca acionados",                      // g3, 120
      "Acordos vencidos",                     // g3, 30
      "Fidelização expira hoje",              // g3, 2
      "Sem acionamento (acima do limite)",    // g2, 300
      "Críticos",                             // g2, 10
      "Acordos em dia sem acompanhamento",    // g2, 5
      "Sem telefone",                         // g1, 400
    ]);

    // Zerados ficam fora: não são prioridade, são ruído.
    const s = secao("Prioridades de gestão").textContent;
    expect(s).not.toContain("Retornos vencidos");
    expect(s).not.toContain("Casos para revisão");
    expect(s).not.toContain("Casos livres");
    expect(s).not.toContain("Sem responsável");
  });

  it("cada prioridade abre a MESMA lista do card, pelo mesmo indicador", async () => {
    await abrirEEsperar();
    const alvo = [...secao("Prioridades de gestão").querySelectorAll("button")]
      .find((b) => b.textContent.includes("Nunca acionados"));
    fireEvent.click(alvo);
    // O drawer abre com o título da prioridade -- é o drill-down que já existia.
    await waitFor(() => expect(screen.getByRole("button", { name: /Fechar/ })).toBeTruthy());
    expect(d.chamadas).toContain("saude_carteira_detalhes");
  });

  // ── 5. PARTICIPAÇÃO NAS TABELAS ─────────────────────────────────────────
  it("Por estabelecimento: participação soma 100% e os saldos não mudam", async () => {
    await abrirEEsperar();
    const s = secao("Por estabelecimento");
    const linhas = [...s.querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((c) => c.textContent.replace(/\u00a0/g, " ")));

    const canoas = linhas.find((c) => c[0].includes("ULBRA CANOAS"));
    const torres = linhas.find((c) => c[0].includes("ULBRA TORRES"));
    const total = linhas.find((c) => c[0].includes("TOTAL DA CARTEIRA"));

    // Saldo vencido intacto, participação na coluna seguinte.
    expect(canoas[3]).toBe("R$ 750.000,00");
    expect(canoas[4]).toContain("75.0%");
    expect(torres[3]).toBe("R$ 250.000,00");
    expect(torres[4]).toContain("25.0%");
    // 75 + 25 = 100, e a linha de total diz 100%.
    expect(total[3]).toBe("R$ 1.000.000,00");
    expect(total[4]).toContain("100.0%");
  });

  it("Por operador: participação soma 100% e o TOTAL vem de `totais`, não da soma das linhas", async () => {
    await abrirEEsperar();
    const linhas = [...secao("Por operador").querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((c) => c.textContent.replace(/\u00a0/g, " ")));

    const ana = linhas.find((c) => c[0].includes("ana@x.com"));
    const bia = linhas.find((c) => c[0].includes("bia@x.com"));
    const total = linhas.find((c) => c[0].includes("TOTAL DA CARTEIRA"));

    expect(ana[4]).toContain("60.0%");
    expect(bia[4]).toContain("40.0%");
    // 600 + 400 = 1.000 casos, que é o mesmo `totais.casos_ativos`: aqui as
    // duas leituras coincidem, mas o que a tela imprime é `totais`.
    expect(total[1]).toBe("1.000");
    expect(total[3]).toBe("R$ 1.000.000,00");
    expect(total[4]).toContain("100.0%");
  });

  it("Por operador agora ordena, e a ordenação não altera valor nenhum", async () => {
    await abrirEEsperar();
    const s = secao("Por operador");
    const emails = () => [...s.querySelectorAll("tbody tr")]
      .map((tr) => tr.querySelector("td").textContent)
      .filter((e) => e.includes("@"));

    // Abre por saldo vencido desc: ana (600k) antes de bia (400k).
    expect(emails()).toEqual(["ana@x.com", "bia@x.com"]);

    const cab = [...s.querySelectorAll("th")].find((t) => t.textContent.startsWith("Saldo vencido"));
    fireEvent.click(cab);
    expect(emails()).toEqual(["bia@x.com", "ana@x.com"]);

    // Os números acompanharam a linha; nenhum foi recalculado.
    const primeira = [...s.querySelectorAll("tbody tr")][0];
    const celulas = [...primeira.querySelectorAll("td")].map((c) => c.textContent.replace(/\u00a0/g, " "));
    expect(celulas[3]).toBe("R$ 400.000,00");
    expect(celulas[4]).toContain("40.0%");
  });

  // ── 6. SEMÁFORO ─────────────────────────────────────────────────────────
  it("o semáforo deixa de ser binário: 10 é âmbar, 400 é vermelho, 0 é verde", async () => {
    await abrirEEsperar();
    const s = secao("Qualidade da carteira");
    // Cabeçalho resume as faixas: 2 em risco (400 e 60), 1 em atenção (10), 1 ok (0).
    expect(s.textContent).toContain("2 risco");
    expect(s.textContent).toContain("1 atenção");
    expect(s.textContent).toContain("1 ok");
  });

  it("Qualidade é ordenada risco → atenção → ok, não pelo nome do campo", async () => {
    await abrirEEsperar();
    const rotulos = [...secao("Qualidade da carteira").querySelectorAll("div > div:first-child")]
      .map((e) => e.textContent)
      .filter((t) => ["Sem telefone", "Sem CPF", "Sem e-mail", "Sem responsável"].includes(t));
    expect(rotulos).toEqual(["Sem telefone", "Sem CPF", "Sem e-mail", "Sem responsável"]);
  });

  it("% sem acionamento ganha cor sem perder o número", async () => {
    await abrirEEsperar();
    const linhas = [...secao("Por estabelecimento").querySelectorAll("tbody tr")];
    const canoas = linhas.find((tr) => tr.textContent.includes("ULBRA CANOAS"));
    const torres = linhas.find((tr) => tr.textContent.includes("ULBRA TORRES"));
    // 40% > limiar de atenção (30) => vermelho; 10% <= 15 => verde.
    expect(canoas.textContent).toContain("40%");
    expect(torres.textContent).toContain("10%");
    const chip = (tr) => [...tr.querySelectorAll("span")].find((e) => e.textContent.trim().match(/^\d+%$/));
    expect(chip(canoas).style.color).toContain("--rv-vermelho-texto");
    expect(chip(torres).style.color).toContain("--rv-verde-ok-texto");
  });

  // ── 7. FILTROS ATUAIS PRESERVADOS ───────────────────────────────────────
  it("os filtros atuais continuam valendo para todas as RPCs da tela", async () => {
    await abrirEEsperar();
    d.filtrosVistos = [];

    const campo = screen.getByRole("spinbutton");
    fireEvent.change(campo, { target: { value: "30" } });
    fireEvent.click(botao());

    await waitFor(() => {
      const nomes = d.filtrosVistos.map(([fn]) => fn);
      expect(nomes).toContain("saude_carteira_resumo");
      expect(nomes).toContain("saude_carteira_qualidade");
      expect(nomes).toContain("saude_carteira_por_curso");
    });
    // Todo mundo recebeu o MESMO filtro, com o valor novo.
    for (const [, f] of d.filtrosVistos) {
      expect(f.min_dias_sem_acionamento).toBe(30);
    }
  });
});

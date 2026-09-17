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

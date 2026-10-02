// @vitest-environment jsdom
//
// COBERTURA DE ACIONAMENTO EM 10 DIAS.
//
// A fixture usa os NUMEROS REAIS medidos em producao em 02/10/2026 (projeto
// ahattpqrjmhkzsmnbdzs, matview de 11:24 UTC, 12.945 casos ativos). Nao sao
// numeros bonitos de teste: sao a prova que autorizou a mudanca, congelada
// aqui. Se a regra mudar, estes valores deixam de bater e alguem precisa
// reexecutar a prova antes de seguir.
//
//   regra                                    dentro   fora   nunca   cobertura
//   ATUAL  (DUA, limite 5)                    1.987  10.958    451      15,3%
//   NOVA   (combinada, <=10 dentro)           5.111   7.834    445      39,5%
//   casos que SAEM da cobertura                   0
//
// O que este arquivo prende:
//  1) "Cobertura da operacao" mostra % ACIONADO, nao % descoberto;
//  2) acao massiva conta -- e o payload de cobertura e quem decide;
//  3) os 10 dias sao fixos na leitura estrategica e NAO seguem o filtro;
//  4) Prioridades 2 e 6 passam a ler cobertura, com valor financeiro;
//  5) o drill-down usa os indicadores novos, para card e lista concordarem;
//  6) sem o payload novo (pre-migration / pos-rollback) a tela NAO quebra.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import SaudeCompletaCarteira from "./SaudeCompletaCarteira";

vi.mock("../utils/exportarSaudeCarteira", () => ({ exportarSaudeCarteira: vi.fn() }));

const BASE = {
  casos_ativos: 12945, cpfs_unicos: 12945,
  saldo_vencido: 30000000, saldo_total: 42070000,
  nunca_acionados: 451,
  sem_acionamento_limite: 10958,
  pct_sem_acionamento: 84.7,
  min_dias_sem_acionamento: 5,
  retornos_vencidos: 0, sem_telefone: 400, sem_responsavel: 12,
  criticos: 10, urgentes: 7,
  acordos_em_dia: 90, acordos_vencidos: 30, acordos_quebrados: 4,
  acordos_em_dia_sem_acompanhamento: 5, casos_revisao: 0,
  fidelizacao_expira_hoje: 2, fidelizacao_vence_amanha: 3,
  casos_livres: 9, saldo_livres: 150000,
};

// Payload DEPOIS da migration 20261002120000.
const COM_COBERTURA = {
  ...BASE,
  dentro_cobertura: 5111,
  fora_cobertura: 7834,
  nunca_coberto: 445,
  pct_cobertura: 39.5,
  saldo_dentro_cobertura: 25010000,
  saldo_fora_cobertura: 16780000,
  saldo_nunca_coberto: 280000,
  cobertura_dias: 10,
};

const d = vi.hoisted(() => ({ chamadas: [], totais: null, filtrosDet: null }));

const resumo = () => ({
  atualizado_em: "2026-10-02T11:24:19.451Z",
  escopo: { is_gestao: true, operador: null },
  totais: d.totais,
  estabelecimentos: [], operadores: [],
  matriz_faixa_atraso: [], matriz_tempo_sem_acionamento: [],
});

vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (fn, args) => {
      d.chamadas.push(fn);
      if (fn === "usuario_e_gestao") return Promise.resolve({ data: true, error: null });
      if (fn === "saude_carteira_detalhes") { d.filtrosDet = args?.p_filtros; return Promise.resolve({ data: { total: 0, rows: [] }, error: null }); }
      if (fn === "saude_carteira_qualidade") return Promise.resolve({ data: { qualidade: {} }, error: null });
      if (fn === "saude_carteira_atualizar") return Promise.resolve({ data: {}, error: null });
      if (fn === "saude_carteira_resumo") {
        const r = { data: resumo(), error: null };
        return { ...Promise.resolve(r), abortSignal: () => Promise.resolve(r) };
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

const corpo = () => document.body.textContent.replace(/\u00a0/g, " ");
const secao = (t) => screen.getByText(t, { selector: "h2" }).parentElement.parentElement;
const linha = (k) => [...secao("Prioridades de gestão").querySelectorAll("[data-prioridade]")]
  .find((e) => e.dataset.prioridade === k);

const abrir = async () => {
  render(<SaudeCompletaCarteira />);
  await waitFor(() => expect(d.chamadas).toContain("usuario_e_gestao"));
  fireEvent.click(screen.getByRole("button", { name: /Recalcular indicadores|Atualizar indicadores/ }));
  await waitFor(() => expect(screen.getByText("Prioridades de gestão", { selector: "h2" })).toBeTruthy());
};

describe("Saúde Completa da Carteira — cobertura de 10 dias", () => {
  beforeEach(() => { d.chamadas = []; d.filtrosDet = null; d.totais = COM_COBERTURA; });
  afterEach(cleanup);

  it("Cobertura da operação mostra o % ACIONADO, não o % descoberto", async () => {
    await abrir();
    const t = corpo();
    // 39,5% acionado. O numero antigo (84,7% SEM acionamento) nao pode aparecer
    // sob o rotulo de cobertura -- era o complemento do que o rotulo prometia.
    expect(t).toContain("39.5%");
    expect(t).toContain("da carteira foi acionada nos últimos 10 dias, contando ação massiva");
    expect(t).toContain("7.834 fora da cobertura");
    expect(t).toContain("445 nunca acionados");
  });

  it("os 10 dias são fixos e NÃO seguem o filtro da tela", async () => {
    await abrir();
    // O filtro continua em 5 (min_dias_sem_acionamento no payload), e mesmo
    // assim a leitura estrategica diz 10: sao perguntas diferentes.
    expect(corpo()).toContain("nos últimos 10 dias");

    const campo = screen.getByRole("spinbutton");
    fireEvent.change(campo, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: /Recalcular indicadores|Atualizar indicadores/ }));
    await waitFor(() => expect(corpo()).toContain("nos últimos 10 dias"));
  });

  it("Sem acionamento no limite passa a ser a cobertura, com valor financeiro", async () => {
    await abrir();
    const l = linha("sem_acionamento_limite").textContent.replace(/\u00a0/g, " ");
    // 7.834 pela cobertura, NAO 10.958 pela regra antiga.
    expect(l).toContain("7.834");
    expect(l).not.toContain("10.958");
    expect(l).toContain("R$ 16.780.000,00");
    expect(l).toContain("há mais de 10 dias sem acionamento válido");
  });

  it("Nunca acionados passa a exigir ausência nas DUAS fontes", async () => {
    await abrir();
    const l = linha("nunca_acionados").textContent.replace(/\u00a0/g, " ");
    // 445 (combinada) e nao 451 (so DUA): 6 casos tem movimentacao e nenhum DUA.
    expect(l).toContain("445");
    expect(l).not.toContain("451");
    expect(l).toContain("R$ 280.000,00");
  });

  it("o drill-down usa o indicador novo — card e lista não podem discordar", async () => {
    await abrir();
    fireEvent.click(linha("sem_acionamento_limite").querySelector("button"));
    await waitFor(() => expect(d.filtrosDet).toBeTruthy());
    expect(d.filtrosDet.indicador).toBe("fora_cobertura");

    fireEvent.click(linha("nunca_acionados").querySelector("button"));
    await waitFor(() => expect(d.filtrosDet.indicador).toBe("nunca_coberto"));
  });

  it("a ordem das 8 prioridades não muda por causa da cobertura", async () => {
    await abrir();
    const ks = [...secao("Prioridades de gestão").querySelectorAll("[data-prioridade]")]
      .map((e) => e.dataset.prioridade);
    expect(ks).toEqual([
      "sem_dono", "sem_acionamento_limite", "acordos_vencidos", "criticos",
      "urgentes", "nunca_acionados", "acordos_em_dia_sem_acompanhamento", "fidelizacao_hoje_amanha",
    ]);
  });

  // ── COMPATIBILIDADE: payload sem cobertura ──────────────────────────────
  // A migration e o deploy do front nao sao atomicos, e o rollback existe.
  // Entre um e outro a RPC devolve o payload antigo, e a tela tem de continuar
  // correta -- nao zerada, nao quebrada.
  describe("sem o payload de cobertura (pré-migration ou pós-rollback)", () => {
    beforeEach(() => { d.totais = BASE; });

    it("cai para a leitura operacional e não mostra zero nem quebra", async () => {
      await abrir();
      const t = corpo();
      // 100 - 84,7 = 15,3% acionado pela regra antiga.
      expect(t).toContain("15.3%");
      expect(t).toContain("da carteira foi acionada dentro do limite do filtro");
      expect(t).toContain("451 nunca foram acionados");
    });

    it("as prioridades voltam aos indicadores antigos, e o drill acompanha", async () => {
      await abrir();
      expect(linha("sem_acionamento_limite").textContent).toContain("10.958");
      expect(linha("nunca_acionados").textContent).toContain("451");

      fireEvent.click(linha("sem_acionamento_limite").querySelector("button"));
      await waitFor(() => expect(d.filtrosDet).toBeTruthy());
      expect(d.filtrosDet.indicador).toBe("sem_acionamento_limite");
    });
  });
});

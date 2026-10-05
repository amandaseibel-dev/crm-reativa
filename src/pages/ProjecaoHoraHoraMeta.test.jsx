// @vitest-environment jsdom
//
// META DAS CONFIGURAÇÕES: a fonte é `metas_projecao`, nunca o snapshot.
//
// BUG MEDIDO EM PRODUÇÃO (02/10/2026): `metas_projecao` de 2026-10 tinha
// meta_operacional 112.400, gravada às 09:44 pela própria gestão; o snapshot
// FILIAL lido pela tela era de 09:29 e trazia `config_metas` com 0. O
// formulário era preenchido pelo snapshot, então a meta recém-salva voltava a
// zero na frente do usuário e parecia "não ter salvo".
//
// Aqui a bancada reproduz exatamente essa divergência: tabela = 112400,
// snapshot = 0. O teste falha se o formulário voltar a ler o snapshot.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, waitFor } from "@testing-library/react";

const rpcMock = vi.fn();
const fromMock = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (...a) => rpcMock(...a),
    auth: { getUser: async () => ({ data: { user: { email: "amanda.seibel@aelbra.com.br" } } }) },
    from: (...a) => fromMock(...a),
  },
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => () => {} }));
vi.mock("../utils/operadores", async (orig) => ({
  ...(await orig()),
  podeGerirFinanceiro: () => true,
  podeVerRelatorios: () => true,
  podeAlterarOperadorProjecao: () => true,
}));
vi.mock("xlsx", () => ({ utils: {}, read: () => ({}) }));
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("../components/BotaoAtualizar", () => ({ default: () => null }));
vi.mock("../components/SuspeitasPagamentosDuplicados", () => ({ default: () => null }));
vi.mock("../components/projecao/SugestoesDonoAcordo", () => ({ default: () => null }));
vi.mock("../components/projecao/AjusteHonorarios", () => ({ default: () => null }));
vi.mock("../components/projecao/GraficoEvolucaoProjecao", () => ({ default: () => null }));
vi.mock("../components/ErrorBoundaryProjecao", () => ({ default: ({ children }) => children }));

import ProjecaoHoraHora from "./ProjecaoHoraHora";

// metas_projecao, por mês. Valores do banco de produção em 02/10.
const TABELA = {
  "2026-10": {
    mes_referencia: "2026-10",
    meta_operacional: 112400, meta_unidades: 10000, meta_honorario: 122400,
    m1_valor: 0.01, m1_percentual: 4, m2_valor: 14050.01, m2_percentual: 8,
    m3_valor: 20232.01, m3_percentual: 9, m4_valor: 25290.01, m4_percentual: 9.5,
  },
  "2026-09": {
    mes_referencia: "2026-09",
    meta_operacional: 98000, meta_unidades: 9000, meta_honorario: 100000,
    m1_valor: 0.01, m1_percentual: 4, m2_valor: 38000.01, m2_percentual: 8,
    m3_valor: 45000.01, m3_percentual: 9, m4_valor: 50000.01, m4_percentual: 9.5,
  },
};

// O snapshot que a tela lia antes: zerado e mais velho que a gravação.
const SNAPSHOT_ZERADO = {
  status: "ok", e_gestao: true, atualizado_em: "2026-10-02T12:29:18Z",
  dados: {
    meta_recuperacao: 0, meta_honorario: 0,
    config_metas: { meta_operacional: 0, meta_unidades: 0, meta_honorario: 0,
      m1_valor: 0, m1_percentual: 0, m2_valor: 0, m2_percentual: 0,
      m3_valor: 0, m3_percentual: 0, m4_valor: 0, m4_percentual: 0 },
  },
};

let tabela;
let erroLeitura;
let atrasoPorMes;      // { [mes]: ms } — para provar a corrida
let chamadasMeta;

function montarSupabase() {
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (nome, args) => {
    if (nome === "projecao_snapshot_ler") return { data: SNAPSHOT_ZERADO };
    if (nome === "projecao_definir_meta") {
      // grava como a RPC real: a linha do mês passa a valer o que veio
      tabela[args.p_mes_referencia] = {
        mes_referencia: args.p_mes_referencia,
        meta_operacional: args.p_meta_operacional, meta_unidades: args.p_meta_unidades,
        meta_honorario: args.p_meta_honorario,
        m1_valor: args.p_m1_valor, m1_percentual: args.p_m1_percentual,
        m2_valor: args.p_m2_valor, m2_percentual: args.p_m2_percentual,
        m3_valor: args.p_m3_valor, m3_percentual: args.p_m3_percentual,
        m4_valor: args.p_m4_valor, m4_percentual: args.p_m4_percentual,
      };
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });

  fromMock.mockReset();
  fromMock.mockImplementation((tab) => {
    if (tab !== "metas_projecao") {
      // demais tabelas: encadeamento inerte
      const inerte = { select: () => inerte, eq: () => inerte, order: () => inerte, limit: () => inerte,
        maybeSingle: async () => ({ data: null }), then: (r) => r({ data: [], error: null }) };
      return inerte;
    }
    let mes = null;
    const q = {
      select: () => q,
      eq: (_col, v) => { mes = v; return q; },
      maybeSingle: async () => {
        chamadasMeta.push(mes);
        const ms = atrasoPorMes[mes] || 0;
        if (ms) await new Promise((r) => setTimeout(r, ms));
        if (erroLeitura) return { data: null, error: { message: erroLeitura } };
        return { data: tabela[mes] || null, error: null };
      },
    };
    return q;
  });
}

async function abrirConfiguracoes() {
  render(<ProjecaoHoraHora />);
  await act(async () => { await Promise.resolve(); });
  const aba = await screen.findByText(/Configura/i);
  await act(async () => { fireEvent.click(aba); });
  return screen.getByLabelText ? null : null;
}

/** Valor do input do campo cujo rótulo (<Campo label=...>) é exatamente `texto`. */
function valorDoCampo(texto) {
  const rotulo = [...document.querySelectorAll("div")].find(
    (n) => n.children.length === 0 && n.textContent.trim() === texto);
  const input = rotulo?.parentElement?.querySelector("input");
  return input ? input.value : null;
}

beforeEach(() => {
  tabela = JSON.parse(JSON.stringify(TABELA));
  erroLeitura = null;
  atrasoPorMes = {};
  chamadasMeta = [];
  montarSupabase();
});
afterEach(cleanup);

describe("Configurações > meta: fonte é metas_projecao, não o snapshot", () => {
  it("1. ao abrir outubro/2026 mostra os valores da tabela, não os zeros do snapshot", async () => {
    await abrirConfiguracoes();
    await waitFor(() => expect(chamadasMeta).toContain("2026-10"));
    await waitFor(() => expect(valorDoCampo("Meta Operacional (R$)")).toBe("112400"));
    expect(valorDoCampo("Meta de honorário (R$)")).toBe("122400");
    // o snapshot zerado foi lido (alimenta os calculados) e NÃO venceu
    expect(rpcMock.mock.calls.some(([n]) => n === "projecao_snapshot_ler")).toBe(true);
  });

  it("5. snapshot com valor divergente (não só zero) jamais chega ao formulário", async () => {
    SNAPSHOT_ZERADO.dados.config_metas.meta_operacional = 999999;
    SNAPSHOT_ZERADO.dados.config_metas.meta_honorario = 888888;
    try {
      await abrirConfiguracoes();
      await waitFor(() => expect(valorDoCampo("Meta Operacional (R$)")).toBe("112400"));
      expect(valorDoCampo("Meta de honorário (R$)")).toBe("122400");
      expect(document.body.innerHTML).not.toContain("999999");
    } finally {
      SNAPSHOT_ZERADO.dados.config_metas.meta_operacional = 0;
      SNAPSHOT_ZERADO.dados.config_metas.meta_honorario = 0;
    }
  });

  it("6 e 7. o snapshot segue sendo lido para os dados calculados; nenhuma RPC de cálculo é chamada ao salvar", async () => {
    await abrirConfiguracoes();
    await waitFor(() => expect(valorDoCampo("Meta Operacional (R$)")).toBe("112400"));
    expect(rpcMock.mock.calls.filter(([n]) => n === "projecao_snapshot_ler").length).toBeGreaterThan(0);

    const antes = rpcMock.mock.calls.map(([n]) => n);
    const botao = [...document.querySelectorAll("button")].find((b) => /salvar/i.test(b.textContent));
    await act(async () => { fireEvent.click(botao); });
    const novas = rpcMock.mock.calls.map(([n]) => n).slice(antes.length);
    // salvar dispara a gravação e nada mais: nenhum recálculo, nenhum snapshot
    expect(novas).toEqual(["projecao_definir_meta"]);
    for (const proibida of ["projecao_snapshot_atualizar", "projecao_calcular_filial",
                            "projecao_dashboard", "projecao_reprocessar_importacao"]) {
      expect(rpcMock.mock.calls.some(([n]) => n === proibida)).toBe(false);
    }
  });

  it("2 e 3. salvar mantém o valor na tela e reabrir continua mostrando o salvo", async () => {
    await abrirConfiguracoes();
    await waitFor(() => expect(valorDoCampo("Meta Operacional (R$)")).toBe("112400"));

    const input = [...document.querySelectorAll("input")].find((i) => i.value === "112400");
    await act(async () => { fireEvent.change(input, { target: { value: "125000" } }); });

    const botao = [...document.querySelectorAll("button")].find((b) => /salvar/i.test(b.textContent));
    await act(async () => { fireEvent.click(botao); });

    // gravou com o valor novo
    const chamada = rpcMock.mock.calls.filter(([n]) => n === "projecao_definir_meta").at(-1)[1];
    expect(chamada.p_meta_operacional).toBe(125000);
    expect(chamada.p_mes_referencia).toBe("2026-10");
    // e a tela releu metas_projecao, não o snapshot
    await waitFor(() => expect(valorDoCampo("Meta Operacional (R$)")).toBe("125000"));
    expect(tabela["2026-10"].meta_operacional).toBe(125000);

    // reabrir (remontar) continua mostrando o salvo
    cleanup();
    await abrirConfiguracoes();
    await waitFor(() => expect(valorDoCampo("Meta Operacional (R$)")).toBe("125000"));
  });

  it("5. não regenera o snapshot ao salvar", async () => {
    await abrirConfiguracoes();
    await waitFor(() => expect(valorDoCampo("Meta Operacional (R$)")).toBe("112400"));
    const botao = [...document.querySelectorAll("button")].find((b) => /salvar/i.test(b.textContent));
    await act(async () => { fireEvent.click(botao); });
    expect(rpcMock.mock.calls.some(([n]) => n === "projecao_snapshot_atualizar")).toBe(false);
  });
});

describe("Configurações > meta: troca de mês e corrida", () => {
  const trocarMes = async (mes) => {
    const input = document.querySelector('input[type="month"]');
    await act(async () => { fireEvent.change(input, { target: { value: mes } }); });
  };

  it("trocar de mês carrega a meta do novo mes_referencia", async () => {
    await abrirConfiguracoes();
    await waitFor(() => expect(valorDoCampo("Meta Operacional (R$)")).toBe("112400"));
    await trocarMes("2026-09");
    await waitFor(() => expect(valorDoCampo("Meta Operacional (R$)")).toBe("98000"));
    expect(chamadasMeta).toContain("2026-09");
  });

  it("resposta lenta de um mês abandonado não pinta o formulário do mês atual", async () => {
    // outubro demora 80ms; setembro responde na hora. Troca-se antes da volta.
    atrasoPorMes["2026-10"] = 80;
    await abrirConfiguracoes();
    await trocarMes("2026-09");
    await waitFor(() => expect(valorDoCampo("Meta Operacional (R$)")).toBe("98000"));
    // a resposta atrasada de outubro chega agora e deve ser descartada
    await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
    expect(valorDoCampo("Meta Operacional (R$)")).toBe("98000");
    expect(document.querySelector('input[type="month"]').value).toBe("2026-09");
  });
});

describe("Configurações > meta: bordas", () => {
  it("mês sem linha em metas_projecao abre zerado, sem erro", async () => {
    delete tabela["2026-10"];
    await abrirConfiguracoes();
    await waitFor(() => expect(chamadasMeta).toContain("2026-10"));
    await waitFor(() => expect(valorDoCampo("Meta Operacional (R$)")).toBe(""));
    expect(document.body.textContent).not.toMatch(/Não foi possível ler a meta/);
  });

  it("falha na leitura mostra erro e não sobrescreve o formulário", async () => {
    await abrirConfiguracoes();
    await waitFor(() => expect(valorDoCampo("Meta Operacional (R$)")).toBe("112400"));
    erroLeitura = "permission denied";
    // força nova leitura do mesmo mês pelo salvamento
    const botao = [...document.querySelectorAll("button")].find((b) => /salvar/i.test(b.textContent));
    await act(async () => { fireEvent.click(botao); });
    await waitFor(() => expect(document.body.textContent).toMatch(/Não foi possível ler a meta/));
    // o que estava em tela permanece: nada foi zerado em silêncio
    expect(valorDoCampo("Meta Operacional (R$)")).toBe("112400");
  });
});

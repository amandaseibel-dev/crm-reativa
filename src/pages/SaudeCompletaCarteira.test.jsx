// @vitest-environment jsdom
//
// "NA SAUDE COMPLETA DA CARTEIRA NAO ESTA ATUALIZANDO" (Amanda, 01/10/2026).
//
// O cron de producao estava SAUDAVEL no dia da queixa -- 24/24 execucoes
// `succeeded` nas ultimas 24h, de hora em hora, 28,5s a 34,9s cada. O que nao
// atualizava era a TELA, por tres motivos somados, e e isso que este arquivo
// prende:
//
//  1) o recalculo era condicionado a `isGestao`, que vem de
//     `resumo.escopo.is_gestao` -- so existe DEPOIS da primeira leitura. No
//     primeiro clique a tela nao recalculava nada: lia a foto da matview;
//  2) a releitura pos-recalculo podia cair no cooldown de 15s do hook, e o
//     recalculo acontecia sem a tela mostrar o resultado;
//  3) sob carga a RPC devolve {skipped:true} COM SUCESSO, e a tela tratava
//     isso como recalculo feito -- numeros iguais e nenhuma explicacao.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import SaudeCompletaCarteira from "./SaudeCompletaCarteira";

// Excel real nao entra em teste de tela (carrega exceljs inteiro sem motivo).
vi.mock("../utils/exportarSaudeCarteira", () => ({ exportarSaudeCarteira: vi.fn() }));

const RESUMO = (atualizadoEm, casosAtivos) => ({
  atualizado_em: atualizadoEm,
  escopo: { is_gestao: true, operador: null },
  totais: { casos_ativos: casosAtivos, cpfs_unicos: 1, saldo_vencido: 1, saldo_total: 1 },
  estabelecimentos: [],
  operadores: [],
  matriz_faixa_atraso: [],
  matriz_tempo_sem_acionamento: [],
});

const FOTO_VELHA = "2026-10-01T14:00:00.000Z";
const FOTO_NOVA = "2026-10-01T14:31:00.000Z";

const d = vi.hoisted(() => ({
  chamadas: [],
  ehGestao: true,
  // fila de respostas de saude_carteira_atualizar; cada clique consome uma
  atualizarRespostas: [],
  // trava o recalculo no ar para inspecionar o botao durante a RPC
  travarAtualizar: null,
  leiturasResumo: 0,
}));

vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (fn) => {
      d.chamadas.push(fn);
      if (fn === "usuario_e_gestao") return Promise.resolve({ data: d.ehGestao, error: null });
      if (fn === "base_data_de_corte") return Promise.resolve({ data: null, error: null });
      if (fn === "saude_carteira_panorama") return Promise.resolve({ data: { total: {} }, error: null });
      if (fn === "saude_carteira_por_curso") return Promise.resolve({ data: { por_curso: [] }, error: null });
      if (fn === "saude_carteira_qualidade") return Promise.resolve({ data: { qualidade: {} }, error: null });
      if (fn === "saude_carteira_resumo") {
        d.leiturasResumo += 1;
        // A base so "muda" depois do primeiro recalculo: e assim que se prova
        // que a tela esta mostrando a foto nova e nao a antiga.
        const foto = d.leiturasResumo === 1 ? FOTO_VELHA : FOTO_NOVA;
        const r = { data: RESUMO(foto, d.leiturasResumo === 1 ? 12950 : 12949), error: null };
        return { ...Promise.resolve(r), abortSignal: () => Promise.resolve(r) };
      }
      if (fn === "saude_carteira_atualizar") {
        const resposta = d.atualizarRespostas.shift()
          || { data: { atualizado_em: FOTO_NOVA, duracao_ms: 29417 }, error: null };
        if (d.travarAtualizar) {
          return new Promise((libera) => { d.travarAtualizar = () => libera(resposta); });
        }
        return Promise.resolve(resposta);
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

const conta = (fn) => d.chamadas.filter((x) => x === fn).length;
const botao = () => screen.getByRole("button", { name: /Recalcular indicadores|Atualizar indicadores|Recalculando|Atualizando/ });

describe("Saúde Completa da Carteira — o botão recalcula de verdade", () => {
  beforeEach(() => {
    d.chamadas = [];
    d.ehGestao = true;
    d.atualizarRespostas = [];
    d.travarAtualizar = null;
    d.leiturasResumo = 0;
  });
  afterEach(cleanup);

  it("recalcula já no PRIMEIRO clique e mostra a foto nova", async () => {
    render(<SaudeCompletaCarteira />);
    // Sob demanda: abrir a tela NAO dispara leitura de indicador nem recalculo.
    await waitFor(() => expect(conta("usuario_e_gestao")).toBe(1));
    expect(conta("saude_carteira_resumo")).toBe(0);
    expect(conta("saude_carteira_atualizar")).toBe(0);

    fireEvent.click(botao());

    await waitFor(() => expect(screen.getByText(/base atualizada em/)).toBeTruthy());
    // UM clique = UM recalculo + UMA leitura. Antes o primeiro clique nao
    // recalculava nada.
    expect(conta("saude_carteira_atualizar")).toBe(1);
    expect(conta("saude_carteira_resumo")).toBe(1);
    // E a leitura veio DEPOIS do recalculo, nao antes.
    expect(d.chamadas.indexOf("saude_carteira_atualizar"))
      .toBeLessThan(d.chamadas.indexOf("saude_carteira_resumo"));
  });

  it("enquanto a RPC roda, o botão fica desabilitado dizendo que está recalculando", async () => {
    d.travarAtualizar = () => {};
    render(<SaudeCompletaCarteira />);
    await waitFor(() => expect(conta("usuario_e_gestao")).toBe(1));

    fireEvent.click(botao());
    await waitFor(() => expect(botao().textContent).toMatch(/Recalculando a base/));
    expect(botao().disabled).toBe(true);
    // Clique repetido durante o recalculo nao empilha uma segunda RPC.
    fireEvent.click(botao());
    expect(conta("saude_carteira_atualizar")).toBe(1);

    d.travarAtualizar();
    await waitFor(() => expect(botao().disabled).toBe(false));
    expect(conta("saude_carteira_atualizar")).toBe(1);
  });

  it("a leitura pós-recálculo NÃO é engolida pelo cooldown de 15s", async () => {
    render(<SaudeCompletaCarteira />);
    await waitFor(() => expect(conta("usuario_e_gestao")).toBe(1));

    fireEvent.click(botao());
    await waitFor(() => expect(conta("saude_carteira_resumo")).toBe(1));
    // Segundo clique imediato, muito dentro dos 15s de cooldown: o recalculo
    // acontece e a releitura TEM de acontecer tambem -- senao a tela fica com
    // o numero velho depois de pagar os ~30s do recalculo.
    fireEvent.click(botao());
    await waitFor(() => expect(conta("saude_carteira_atualizar")).toBe(2));
    await waitFor(() => expect(conta("saude_carteira_resumo")).toBe(2));
  });

  it("recálculo adiado pelo disjuntor aparece escrito na tela", async () => {
    d.atualizarRespostas = [{ data: { skipped: true, motivo: "sistema_sob_carga" }, error: null }];
    render(<SaudeCompletaCarteira />);
    await waitFor(() => expect(conta("usuario_e_gestao")).toBe(1));

    fireEvent.click(botao());
    await waitFor(() => expect(screen.getByText(/Recálculo adiado/)).toBeTruthy());
    expect(screen.getByText(/sob carga/)).toBeTruthy();
    // Adiar nao cega a tela: a ultima foto continua sendo lida e mostrada.
    expect(conta("saude_carteira_resumo")).toBe(1);
  });

  it("erro no recálculo avisa, mas não impede a leitura", async () => {
    d.atualizarRespostas = [{ data: null, error: { code: "57014", message: "timeout" } }];
    render(<SaudeCompletaCarteira />);
    await waitFor(() => expect(conta("usuario_e_gestao")).toBe(1));

    fireEvent.click(botao());
    await waitFor(() => expect(screen.getByText(/Não foi possível recalcular agora/)).toBeTruthy());
    expect(conta("saude_carteira_resumo")).toBe(1);
  });

  it("Panorama e Por curso também recarregam no clique", async () => {
    render(<SaudeCompletaCarteira />);
    // Uma vez na abertura cada um.
    await waitFor(() => expect(conta("saude_carteira_panorama")).toBe(1));
    await waitFor(() => expect(conta("saude_carteira_por_curso")).toBe(1));

    fireEvent.click(botao());
    await waitFor(() => expect(conta("saude_carteira_panorama")).toBe(2));
    expect(conta("saude_carteira_por_curso")).toBe(2);
  });

  it("quem não é gestão não dispara a RPC pesada nem recebe erro de permissão", async () => {
    d.ehGestao = false;
    render(<SaudeCompletaCarteira />);
    await waitFor(() => expect(botao().textContent).toMatch(/Atualizar indicadores/));

    fireEvent.click(botao());
    await waitFor(() => expect(conta("saude_carteira_resumo")).toBe(1));
    // Nenhuma chamada recusada com 42501: a decisao e tomada antes, pelo
    // proprio `usuario_e_gestao()`.
    expect(conta("saude_carteira_atualizar")).toBe(0);
    expect(screen.queryByText(/Não foi possível recalcular/)).toBeNull();
  });
});

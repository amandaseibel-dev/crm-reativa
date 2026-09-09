// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import VigiaInvariantes from "./VigiaInvariantes";

const q = vi.hoisted(() => ({ rpcs: [], painel: [] }));

vi.mock("../services/supabase", () => ({
  supabase: {
    rpc(nome) {
      q.rpcs.push(nome);
      if (nome === "invariantes_painel") return Promise.resolve({ data: q.painel, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

const linha = (extra) => ({
  nome: "x", titulo: "Checagem", severidade: "INFO", explicacao: "explica",
  base_09_09: "0", ligado: true, achados: 0, valor: null, detalhe: null,
  rodado_em: "2026-09-09T12:00:00Z", variacao: null, ...extra,
});

beforeEach(() => { q.rpcs = []; q.painel = []; });
afterEach(cleanup);

describe("Vigia de invariantes", () => {
  it("le o painel pela RPC de gestao", async () => {
    render(<VigiaInvariantes />);
    await waitFor(() => expect(q.rpcs).toContain("invariantes_painel"));
  });

  it("mostra quantas checagens estao apontando algo e quantas sao graves", async () => {
    q.painel = [
      linha({ nome: "a", severidade: "GRAVE", achados: 1150, titulo: "Cobrando quem ja pagou" }),
      linha({ nome: "b", severidade: "ATENCAO", achados: 19 }),
      linha({ nome: "c", achados: 0 }),
    ];
    render(<VigiaInvariantes />);
    await waitFor(() =>
      expect(screen.getByText(/2 de 3 checagens apontando algo — 1 grave\b/)).toBeTruthy()
    );
  });

  it("nao pluraliza errado quando nada aponta", async () => {
    q.painel = [linha({ achados: 0 })];
    render(<VigiaInvariantes />);
    await waitFor(() =>
      expect(screen.getByText("Nenhuma checagem apontando nada agora.")).toBeTruthy()
    );
  });

  // Duas checagens contam TEMPO. Sem a unidade, "1234" pareceria 1.234 fichas
  // com problema quando e uma matview parada ha 20 horas.
  it("mostra minutos na matview e dias no bordero", async () => {
    q.painel = [
      linha({ nome: "matview_saude_velha", achados: 180, titulo: "Saude da Carteira desatualizada" }),
      linha({ nome: "bordero_atrasado", achados: 40, titulo: "Bordero atrasado" }),
    ];
    render(<VigiaInvariantes />);
    await waitFor(() => expect(screen.getByText("min")).toBeTruthy());
    expect(screen.getByText("dias")).toBeTruthy();
  });

  it("nomeia as rotinas que falharam, em vez de so contar", async () => {
    q.painel = [linha({ nome: "cron_com_falha", achados: 10, detalhe: ["casos_reabrir_com_divida_horario"] })];
    render(<VigiaInvariantes />);
    await waitFor(() =>
      expect(screen.getByText(/casos_reabrir_com_divida_horario/)).toBeTruthy()
    );
  });

  it("mostra o valor em reais quando a checagem tem dinheiro atras", async () => {
    q.painel = [linha({ achados: 34, valor: 89988.24 })];
    render(<VigiaInvariantes />);
    await waitFor(() => expect(screen.getByText(/89\.988,24/)).toBeTruthy());
  });

  // invariantes_rodar NAO tem grant para authenticated. Se a tela chamasse ela
  // direto, o botao daria "permission denied" para a propria gestao.
  it("o botao passa pela porta estreita invariantes_conferir_agora", async () => {
    q.painel = [linha({})];
    render(<VigiaInvariantes />);
    await waitFor(() => expect(screen.getByText("Conferir agora")).toBeTruthy());
    fireEvent.click(screen.getByText("Conferir agora"));
    await waitFor(() => expect(q.rpcs).toContain("invariantes_conferir_agora"));
    expect(q.rpcs).not.toContain("invariantes_rodar");
  });

  it("mostra a linha de base de 09/09 ao lado do numero de hoje", async () => {
    q.painel = [linha({ achados: 7, base_09_09: "7" })];
    render(<VigiaInvariantes />);
    await waitFor(() => expect(screen.getByText(/Em 09\/09: 7/)).toBeTruthy());
  });

  it("mostra a variacao desde a rodada anterior, com sinal", async () => {
    q.painel = [linha({ achados: 12, variacao: 5 })];
    render(<VigiaInvariantes />);
    await waitFor(() => expect(screen.getByText(/desde a rodada anterior: \+5/)).toBeTruthy());
  });
});

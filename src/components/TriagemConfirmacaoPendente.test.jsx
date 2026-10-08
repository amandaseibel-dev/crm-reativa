// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import TriagemConfirmacaoPendente from "./TriagemConfirmacaoPendente";

// O que se prova: o painel é SÓ LEITURA, mostra os três grupos (inclusive o
// vazio), abre a composição do bloqueio e faz a conferência que a gestão pediu
// — se os elegíveis estão de fato na mão de um operador.
//
// Os números são os MEDIDOS em produção em 08/10/2026: 201 alunos / 232
// solicitações; 168 devolvem saldo, 33 com outro bloqueio, 0 encerram; e dos
// 168, só 135 voltam para operador ativo.
const TRIAGEM = {
  gerado_em: "2026-10-08T12:00:00Z",
  alunos_pendentes: 201,
  solicitacoes_abertas: 232,
  grupos: [
    { grupo: "DEVOLVE_SALDO", alunos: 168, saldo: 823573.46, valor_informado: 263547.62,
      espera_mais_antiga: "2026-07-22T10:00:00Z", com_caso_encerrado: 6,
      com_status_bloqueio: 1, com_nao_acionar: 0, sem_operador: 0 },
    { grupo: "OUTRO_BLOQUEIO", alunos: 33, saldo: 78338.74, valor_informado: 132110.22,
      espera_mais_antiga: "2026-07-24T10:00:00Z", com_caso_encerrado: 4,
      com_status_bloqueio: 24, com_nao_acionar: 0, sem_operador: 7 },
  ],
  destino_dos_elegiveis: [
    { destino: "OPERADOR_ATIVO", alunos: 135, saldo: 711579.01 },
    { destino: "CARTEIRA_GERAL", alunos: 28, saldo: 96977.35 },
    { destino: "NAO_E_OPERADOR_ATIVO", alunos: 5, saldo: 15017.1 },
  ],
  itens: [],
};

const txt = () => document.body.textContent.replace(/\u00a0/g, " ");
const responder = (payload, error = null) =>
  rpcMock.mockImplementation(() => Promise.resolve({ data: payload, error }));
const montar = () => act(async () => { render(<TriagemConfirmacaoPendente />); });

beforeEach(() => { rpcMock.mockReset(); responder(TRIAGEM); });
afterEach(() => cleanup());

describe("Triagem da fila de confirmação", () => {
  it("lê a RPC de triagem e nenhuma consulta ampla por linha", async () => {
    await montar();
    expect(rpcMock).toHaveBeenCalledWith("confirmacao_pendente_triagem");
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("mostra os três grupos de decisão", async () => {
    await montar();
    expect(screen.getByText("A decisão encerra a cobrança")).toBeTruthy();
    expect(screen.getByText("Devolve saldo elegível para retorno")).toBeTruthy();
    expect(screen.getByText("Tem outro bloqueio")).toBeTruthy();
  });

  it("o grupo vazio aparece com zero e diz por quê — não desaparece", async () => {
    await montar();
    const card = screen.getByText("A decisão encerra a cobrança").closest("article");
    expect(card.textContent).toContain("0");
    expect(card.textContent).toMatch(/todos os pendentes têm saldo em aberto/);
    expect(card.textContent).toMatch(/decisão de gestão, com motivo escrito/);
  });

  it("abre a composição do bloqueio e avisa que os motivos não somam", async () => {
    await montar();
    const card = screen.getByText("Tem outro bloqueio").closest("article");
    expect(card.textContent).toContain("24");
    expect(card.textContent).toContain("7");
    expect(card.textContent).toMatch(/se sobrepõem e não somam/);
  });

  it("faz a conferência de disponibilidade dos elegíveis", async () => {
    await montar();
    expect(txt()).toContain("Dos 168 elegíveis, para onde a decisão os devolve");
    expect(screen.getByText("Com operador ativo")).toBeTruthy();
    expect(screen.getByText("Parados na Carteira Geral")).toBeTruthy();
  });

  it("soma e destaca quem NÃO volta para operador nenhum", async () => {
    await montar();
    // 28 na Carteira Geral + 5 com quem não é operador = 33
    expect(txt()).toMatch(/33 dos elegíveis não voltam para operador nenhum/);
    expect(txt()).toMatch(/decisão de distribuição/);
  });

  it("declara que não libera ninguém e não remove bloqueio", async () => {
    await montar();
    expect(txt()).toMatch(/Este painel não libera ninguém/);
    expect(txt()).toMatch(/Nenhuma suspensão, cancelamento ou “não acionar” é removido/);
    // e não existe botão de ação nenhum no painel
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("erro da RPC aparece e diz que a lista da aba segue válida", async () => {
    responder(null, { message: "Acesso negado." });
    await montar();
    expect(txt()).toMatch(/Não foi possível triar a fila de confirmação: Acesso negado/);
    expect(txt()).toMatch(/A lista abaixo não depende desta consulta/);
  });
});

// @vitest-environment jsdom
//
// O que se prova aqui:
//   1. abrir é SIMULAÇÃO: a primeira chamada vai com p_confirmar = false e
//      a tela vem preenchida com o que o pagamento já sabe;
//   2. a decisão da gestão (mensalidades) fica destacada, e mudar a escolha
//      refaz a simulação antes de qualquer confirmação;
//   3. confirmar envia a escolha EXPLÍCITA, nunca a sugestão;
//   4. ausência não explicada e diferença acima da margem segura (1,15)
//      bloqueiam, sem campo nenhum de liberação manual;
//   5. recusa do banco na confirmação não vira sucesso na tela.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import RegistrarAcordoAvista from "./RegistrarAcordoAvista";

const ITEM = { pagamento_id: "p1", status_conciliacao: "AGUARDANDO_ACORDO" };

const PREVIA_OK = {
  ok: true, modo: "SIMULACAO", gravou: false, aprovado: true, bloqueios: [],
  pagamento: { id: "p1", boleto: "50720660001", matricula: "2023000752", nome_no_arquivo: "Maria da Silva",
    valor_pago: 1236.38, data_pagamento: "2026-09-15", vencimento: "2026-09-18", operador_email: "cobranca11@aelbra.com.br" },
  aluno: { id: "a1", nome: "Maria da Silva", cpf_mascarado: "***.826.041-**" },
  boleto: { numero_ulbra: "72066", parcela: "0001", evidencia_existia_antes: null },
  acordo_a_criar: { numero_ulbra: "72066", valor_total: 1236.38, operador_responsavel_nome: "Allan",
    operador_responsavel_email: "cobranca11@aelbra.com.br" },
  parcela_a_criar: { boleto: "50720660001", valor: 1236.38, vencimento: "2026-09-18" },
  titulos: {
    selecao: "SUGERIDA", quantidade: 1, soma: 1093.12,
    faixa_valor_pago: { soma_minima: 1075.11, soma_maxima: 1236.38, margem_segura: 1.15 },
    selecionados: [{ id: "t1", documento: "4527055", vencimento: "2026-08-05", valor: 1093.12 }],
    candidatos: [{ id: "t1", documento: "4527055", vencimento: "2026-08-05", valor: 1093.12, impedimento: null, selecionado: true }],
  },
  credito: { operador_nome: "Allan", operador_email: "cobranca11@aelbra.com.br" },
  saldo: { antes: 1093.12, esperado_depois: 0 },
  efeitos: ["o motor atual baixa a parcela 1 pelo boleto e o acordo fecha como QUITADO"],
  validacoes: [
    { codigo: "MATRICULA_E_NOME_MESMO_ALUNO", ok: true, detalhe: "por matrícula: a1 · por nome: a1" },
    { codigo: "AUSENCIA_EXPLICADA", ok: true, detalhe: "nenhum acordo de número maior foi importado antes do dia do pagamento" },
  ],
};

const PREVIA_SEM_TITULO = {
  ...PREVIA_OK, aprovado: false, bloqueios: ["TITULOS_ESCOLHIDOS", "SOMA_ATE_O_VALOR_PAGO", "DIFERENCA_DENTRO_DA_MARGEM_SEGURA"],
  titulos: { ...PREVIA_OK.titulos, selecao: "GESTAO", quantidade: 0, soma: 0, selecionados: [],
    candidatos: [{ ...PREVIA_OK.titulos.candidatos[0], selecionado: false }] },
};

const PREVIA_AUSENCIA = {
  ...PREVIA_OK, aprovado: false, bloqueios: ["AUSENCIA_EXPLICADA", "DIFERENCA_DENTRO_DA_MARGEM_SEGURA"],
  boleto: { ...PREVIA_OK.boleto, numero_ulbra: "71752", evidencia_existia_antes: { numero_ulbra: "71757" } },
  validacoes: [
    { codigo: "AUSENCIA_EXPLICADA", ok: false,
      detalhe: "o acordo 71757, de número maior, já veio na importação de 14/09/2026 08:13 | fora do fluxo normal: exige tratamento operacional à parte" },
    { codigo: "DIFERENCA_DENTRO_DA_MARGEM_SEGURA", ok: false,
      detalhe: "valor pago 816.63 = soma × 1,2636 · a diferença excede a margem segura de 15% (limite: soma × 1,15)" },
  ],
};

function responder(...respostas) {
  let i = 0;
  rpcMock.mockImplementation(() => Promise.resolve({ data: respostas[Math.min(i++, respostas.length - 1)], error: null }));
}

beforeEach(() => { rpcMock.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Registrar acordo à vista", () => {
  it("abre em simulação, preenchido com o que o pagamento já sabe", async () => {
    responder(PREVIA_OK);
    await act(async () => { render(<RegistrarAcordoAvista item={ITEM} onFechar={() => {}} />); });

    expect(rpcMock).toHaveBeenCalledWith("acordo_avista_registrar", {
      p_pagamento_id: "p1", p_titulo_ids: null, p_confirmar: false,
    });
    expect(screen.getAllByText("72066").length).toBeGreaterThan(0);
    expect(screen.getAllByText("50720660001").length).toBeGreaterThan(0);
    expect(screen.getByText("2023000752")).toBeTruthy();
    expect(screen.getAllByText("Allan").length).toBeGreaterThan(0);
    expect(screen.getByText(/Decisão da gestão: quais mensalidades/)).toBeTruthy();
    expect(screen.getByText(/Simulação aprovada\. Nada foi gravado ainda\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirmar registro" }).disabled).toBe(false);
  });

  it("mudar a escolha refaz a simulação, e a recusa desabilita a confirmação", async () => {
    responder(PREVIA_OK, PREVIA_SEM_TITULO);
    await act(async () => { render(<RegistrarAcordoAvista item={ITEM} onFechar={() => {}} />); });
    await act(async () => { fireEvent.click(screen.getByRole("checkbox")); });

    expect(rpcMock).toHaveBeenLastCalledWith("acordo_avista_registrar", expect.objectContaining({
      p_titulo_ids: [], p_confirmar: false,
    }));
    expect(screen.getByText(/Simulação recusada/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirmar registro" }).disabled).toBe(true);
  });

  it("confirmar envia a escolha explícita, nunca a sugestão", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onRegistrado = vi.fn();
    responder(PREVIA_OK, { ...PREVIA_OK, modo: "CONFIRMADO", gravou: true, acordo_id: "ac1" });
    await act(async () => { render(<RegistrarAcordoAvista item={ITEM} onFechar={() => {}} onRegistrado={onRegistrado} />); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirmar registro" })); });

    expect(rpcMock).toHaveBeenLastCalledWith("acordo_avista_registrar", {
      p_pagamento_id: "p1", p_titulo_ids: ["t1"], p_confirmar: true,
    });
    expect(onRegistrado).toHaveBeenCalled();
    expect(screen.getByText(/Registrado: acordo ULBRA 72066/)).toBeTruthy();
  });

  it("sem o ok do window.confirm, nada é enviado para gravar", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    responder(PREVIA_OK);
    await act(async () => { render(<RegistrarAcordoAvista item={ITEM} onFechar={() => {}} />); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirmar registro" })); });

    expect(rpcMock.mock.calls.some(([, args]) => args.p_confirmar === true)).toBe(false);
  });

  it("ausência não explicada e diferença acima da margem bloqueiam, sem liberação manual", async () => {
    responder(PREVIA_AUSENCIA);
    await act(async () => { render(<RegistrarAcordoAvista item={ITEM} onFechar={() => {}} />); });

    expect(screen.getByText("Fora do fluxo normal")).toBeTruthy();
    expect(screen.getAllByText(/71757/).length).toBeGreaterThan(0);
    // aparece destacada junto da decisão, e de novo na lista de validações
    expect(screen.getByText(/excede a margem segura de 15% .*O registro normal não é permitido/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirmar registro" }).disabled).toBe(true);
    // nenhum campo de texto que libere a trava
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/confirmação operacional obrigatória/i)).toBeNull();
  });

  it("recusa do banco na confirmação não vira sucesso", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    responder(PREVIA_OK, { ...PREVIA_OK, ok: false, modo: "RECUSADO", gravou: false, aprovado: false,
      bloqueios: ["NUMERO_ULBRA_INEXISTENTE"] });
    await act(async () => { render(<RegistrarAcordoAvista item={ITEM} onFechar={() => {}} />); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirmar registro" })); });

    expect(screen.getByText(/Recusado na confirmação, nada foi gravado: NUMERO_ULBRA_INEXISTENTE/)).toBeTruthy();
    expect(screen.queryByText(/Registrado: acordo/)).toBeNull();
  });
});

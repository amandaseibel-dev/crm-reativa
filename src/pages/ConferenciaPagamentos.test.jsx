// @vitest-environment jsdom
//
// O QUE ESTA SUÍTE PROTEGE na Confirmação de Pagamento:
//   1. pagamento normal confirma em UM clique -- sem diálogo "Sim/Não";
//   2. dois cliques no mesmo botão registram UMA baixa só (era o diálogo que
//      segurava o segundo clique; agora é a trava em memória);
//   3. linha que QUITARIA o caso (saldo zerado) não confirma em um clique --
//      ela cai na análise, que é a proteção contra quitação indevida;
//   4. a análise é informativa: abrir não chama RPC nenhuma;
//   5. "Já tratado" continua exigindo motivo, mas os casos comuns são um clique
//      -- e esse caminho NUNCA chama a baixa do extrato;
//   6. nome, CPF, responsável, valor e data aparecem prontos na tela;
//   7. o clique único exige identidade (CPF) e nenhuma baixa prévia na janela;
//   8. o Desfazer diz, ANTES do clique, que não estorna a baixa.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));
vi.mock("./Aluno", () => ({ default: () => null }));
vi.mock("../components/ResolverEmConfirmacao", () => ({ default: () => null }));

import ConferenciaPagamentos from "./ConferenciaPagamentos";

const BASE = {
  tipo: "COM_ALUNO", aluno_id: "a1", nome: "JOSE DA SILVA", cpf: "111.222.333-44",
  responsavel: "Fernanda", entrou: 500, qtd_pagamentos: 1,
  primeiro_pagamento: "2026-10-10", ultimo_pagamento: "2026-10-10",
  baixado: 0, qtd_baixas: 0, baixado_por: null, ultima_baixa: null,
  saldo_aberto: 1200, saldo_em_acordo: 700, saldo_em_mensalidade: 500, saldo_vencido: 0,
  tem_acordo: true, quitado_em: null, pagamento_ids: ["p1"],
  em_confirmacao: 0, qtd_em_confirmacao: 0,
  total_linhas: 1, total_pagamentos: 1, total_entrou: 500, total_baixado: 0, total_saldo: 1200,
};

function montar(linhas) {
  rpcMock.mockImplementation((nome) => {
    if (nome === "conferencia_pagamentos") return Promise.resolve({ data: linhas, error: null });
    return Promise.resolve({ data: null, error: null });
  });
  return act(async () => { render(<ConferenciaPagamentos />); });
}

const chamadas = (nome) => rpcMock.mock.calls.filter((c) => c[0] === nome);

beforeEach(() => { rpcMock.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Confirmação de Pagamento", () => {
  it("mostra nome, CPF, responsável, valor e data sem pedir digitação", async () => {
    await montar([BASE]);
    expect(screen.getByText("JOSE DA SILVA")).toBeTruthy();
    expect(screen.getByText(/111\.222\.333-44/)).toBeTruthy();
    expect(screen.getByText(/Fernanda/)).toBeTruthy();
    expect(screen.getByText(/10\/10\/2026/)).toBeTruthy();
    expect(screen.getAllByText(/500,00/).length).toBeGreaterThan(0);
  });

  it("pagamento normal: um clique em Confirmar registra a baixa e carimba", async () => {
    await montar([BASE]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirmar" })); });

    expect(chamadas("conferencia_baixar_do_extrato")).toHaveLength(1);
    expect(chamadas("conferencia_baixar_do_extrato")[0][1]).toMatchObject({
      p_aluno_id: "a1", p_valor: 500, p_data: "2026-10-10",
    });
    expect(chamadas("confirmar_baixa_caso")).toHaveLength(1);
    expect(chamadas("conciliacao_santander_decidir")[0][1]).toMatchObject({ p_decisao: "CONFIRMADO" });
    // nenhum diálogo intermediário entrou no caminho
    expect(screen.queryByRole("button", { name: "Sim" })).toBeNull();
  });

  it("dois cliques seguidos não geram baixa em dobro", async () => {
    await montar([BASE]);
    const btn = screen.getByRole("button", { name: "Confirmar" });
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn); });
    expect(chamadas("conferencia_baixar_do_extrato")).toHaveLength(1);
  });

  it("saldo zerado NÃO confirma em um clique: cai na análise", async () => {
    await montar([{ ...BASE, saldo_aberto: 0, saldo_em_acordo: 0, saldo_em_mensalidade: 0 }]);
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    const resolver = screen.getByRole("button", { name: "Resolver divergência" });

    await act(async () => { fireEvent.click(resolver); });
    // abrir a análise não mexe em dinheiro
    expect(chamadas("conferencia_baixar_do_extrato")).toHaveLength(0);
    expect(screen.getByText(/Precisa de análise/)).toBeTruthy();
    expect(screen.getByText(/confirmar aqui deixa o caso quitar/)).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirmar mesmo assim" })); });
    expect(chamadas("conferencia_baixar_do_extrato")).toHaveLength(1);
  });

  it("cadastro sem CPF não confirma em um clique", async () => {
    await montar([{ ...BASE, cpf: null }]);
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resolver divergência" })); });
    expect(screen.getByText(/sem CPF/)).toBeTruthy();
  });

  it("baixa prévia na janela não confirma em um clique, mesmo com a soma batendo", async () => {
    await montar([{ ...BASE, entrou: 500, baixado: 500, qtd_baixas: 2 }]);
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resolver divergência" })); });
    expect(screen.getByText(/já existe baixa nesta janela/)).toBeTruthy();
    expect(chamadas("conferencia_baixar_do_extrato")).toHaveLength(0);
  });

  it("o aviso do Desfazer diz que a baixa não é estornada antes do clique", async () => {
    await montar([BASE]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirmar" })); });
    expect(screen.getByText(/não estorna a baixa/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Voltar à fila/ })).toBeTruthy();
  });

  it("o carimbo Já tratado não repete esse aviso: ele não criou baixa", async () => {
    await montar([BASE]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Já tratado" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cartão baixado no Prime" })); });
    expect(screen.getByText(/nenhuma baixa foi criada/)).toBeTruthy();
    expect(screen.queryByText(/não estorna a baixa/)).toBeNull();
  });

  it("baixa diferente do extrato também pede análise", async () => {
    await montar([{ ...BASE, entrou: 500, baixado: 430 }]);
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resolver divergência" })); });
    expect(screen.getByText(/o valor baixado não é o valor que entrou/)).toBeTruthy();
  });

  it("pagamento depois da quitação pede análise", async () => {
    await montar([{ ...BASE, quitado_em: "2026-09-01" }]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resolver divergência" })); });
    expect(screen.getByText(/entrou depois da quitação/)).toBeTruthy();
  });

  it("Já tratado: motivo pronto em um clique, e sem baixa nenhuma", async () => {
    await montar([BASE]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Já tratado" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cartão baixado no Prime" })); });

    expect(chamadas("conferencia_baixar_do_extrato")).toHaveLength(0);
    expect(chamadas("confirmar_baixa_caso")).toHaveLength(0);
    expect(chamadas("conciliacao_santander_decidir")[0][1]).toMatchObject({
      p_decisao: "JA_TRATADO", p_motivo: "Cartão baixado no Prime",
    });
  });

  it("Já tratado sem motivo não carimba", async () => {
    const avisos = vi.spyOn(window, "alert").mockImplementation(() => {});
    await montar([BASE]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Já tratado" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Carimbar" })); });
    expect(chamadas("conciliacao_santander_decidir")).toHaveLength(0);
    expect(avisos).toHaveBeenCalled();
  });

  it("pagamento sem vínculo continua no caminho de vincular", async () => {
    await montar([{
      ...BASE, tipo: "SEM_VINCULO", aluno_id: null, cpf: null, responsavel: "(sem dono)",
      saldo_aberto: 0, saldo_em_acordo: 0, saldo_em_mensalidade: 0,
    }]);
    expect(screen.getByRole("button", { name: "Vincular" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolver divergência" })).toBeNull();
  });
});

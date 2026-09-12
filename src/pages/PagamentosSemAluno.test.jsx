// @vitest-environment jsdom
//
// A fila de exceção é o portão operacional do canário: se ela não mostrar o
// MOTIVO FINANCEIRO e não tratar os candidatos como sugestão, a regra nova
// vira pagamento sem dono. O que se prova aqui:
//   1. a tela pede a pendência de todos os meses quando a gestão marca a caixa
//      (os pagamentos sem vínculo de hoje são todos de um mês antigo);
//   2. o motivo financeiro aparece na linha, não escondido;
//   3. candidato por nome é SUGESTÃO -- renderiza, mas nada vincula sem clique;
//   4. o vínculo só sai por pagamento_vincular_aluno, com o motivo no histórico.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));
vi.mock("../components/CadastroNovoAluno", () => ({ default: () => null }));
vi.mock("../components/DadosAcademicos", () => ({ default: () => null }));
vi.mock("./Aluno", () => ({ default: () => null }));

import PagamentosSemAluno from "./PagamentosSemAluno";

const LINHA = {
  pagamento_id: "p1",
  data_pagamento: "2026-07-18",
  aluno_nome: "JOSE DA SILVA",
  matricula: "2026002032",
  titulo_numero: "4295892",
  numero_parcela_completo: "50716220001",
  valor_pago: 536.13,
  valor_honorario: 53.61,
  operador_nome: "Operador Teste",
  operador_email: "op@teste.com",
  motivo: "SEM_CADASTRO",
  candidatos: 1,
  motivo_financeiro:
    "boleto 50716220001 nao existe em parcelas e o acordo 071622 nao esta no CRM",
  sugestoes: [
    { aluno_id: "a9", nome: "José da Silva", cpf_mascarado: "***.333", matricula: "1234", tem_acordo_ativo: true },
  ],
  detectado_em: "2026-09-12T13:00:00Z",
  importacao_id: "i1",
  arquivo_nome: "parcial 12.09.xlsx",
};

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: [LINHA], error: null });
});
afterEach(cleanup);

describe("Fila de pagamentos sem vínculo", () => {
  it("mostra o motivo financeiro e o boleto na própria linha", async () => {
    await act(async () => { render(<PagamentosSemAluno />); });

    expect(screen.getByText(/por que caiu aqui/i)).toBeTruthy();
    expect(
      screen.getByText(/boleto 50716220001 nao existe em parcelas/i),
    ).toBeTruthy();
    // o identificador financeiro vem antes do nome na leitura da linha
    expect(screen.getByText(/boleto 50716220001 · título 4295892/i)).toBeTruthy();
  });

  it("pede a pendência de todos os meses quando a gestão marca a caixa", async () => {
    await act(async () => { render(<PagamentosSemAluno />); });
    expect(rpcMock).toHaveBeenCalledWith(
      "pagamentos_sem_aluno",
      expect.objectContaining({ p_todos_os_meses: false }),
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText(/toda a pendência/i));
    });
    expect(rpcMock).toHaveBeenCalledWith(
      "pagamentos_sem_aluno",
      expect.objectContaining({ p_todos_os_meses: true }),
    );
  });

  it("candidato por nome é sugestão: aparece rotulado, e não vincula sozinho", async () => {
    await act(async () => { render(<PagamentosSemAluno />); });
    await act(async () => { fireEvent.click(screen.getByText("Resolver")); });

    expect(screen.getByText(/1 sugestão por nome/i)).toBeTruthy();
    expect(screen.getByText(/nome não é prova/i)).toBeTruthy();
    expect(screen.getByText("José da Silva")).toBeTruthy();

    // abrir a linha NÃO pode ter vinculado nada
    expect(
      rpcMock.mock.calls.some((c) => c[0] === "pagamento_vincular_aluno"),
    ).toBe(false);
  });

  it("o vínculo sai por pagamento_vincular_aluno e leva o motivo para o histórico", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    rpcMock.mockImplementation((nome) =>
      nome === "pagamento_vincular_aluno"
        ? Promise.resolve({ data: { ok: true, aluno_nome: "José da Silva" }, error: null })
        : Promise.resolve({ data: [LINHA], error: null }),
    );

    await act(async () => { render(<PagamentosSemAluno />); });
    await act(async () => { fireEvent.click(screen.getByText("Resolver")); });
    await act(async () => { fireEvent.click(screen.getByText("Vincular")); });

    const chamada = rpcMock.mock.calls.find((c) => c[0] === "pagamento_vincular_aluno");
    expect(chamada).toBeTruthy();
    expect(chamada[1].p_pagamento_id).toBe("p1");
    expect(chamada[1].p_aluno_id).toBe("a9");
    expect(chamada[1].p_observacao).toMatch(/50716220001/);
    expect(chamada[1].p_observacao).toMatch(/nao esta no CRM/);
  });
});

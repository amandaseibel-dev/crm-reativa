// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// Dublê da RPC: o que se prova aqui é a LEITURA da fila -- o acordo quitado
// tem de aparecer como acordo, e não como "pagou, sem acordo".
const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import MensalidadesAVincular from "./MensalidadesAVincular";

const RESPOSTA = {
  total: 2, limite: 100, offset: 0,
  resumo: {
    ACORDO_E_PAGOU: { alunos: 1, titulos: 2, valor: 1000 },
    ACORDO_QUITADO: { alunos: 1, titulos: 4, valor: 54519.12 },
  },
  itens: [
    {
      aluno_id: "a1", nome: "Ana Ativa", cpf: "***.111", responsavel: "Maria",
      situacao: "ACORDO_E_PAGOU", titulos: 2, valor_mensalidade: 1000,
      acordos: 1, acordo_status: "ATIVO", numero_acordo: 10, saldo_acordo: 500, valor_acordo: 900,
      quitado_em: null, acordos_com_parcela_paga: 1, valor_pago: 400, ultimo_pagamento: "2026-07-17",
    },
    {
      aluno_id: "a2", nome: "Sinara Quitada", cpf: "***.222", responsavel: "João",
      situacao: "ACORDO_QUITADO", titulos: 4, valor_mensalidade: 54519.12,
      acordos: 1, acordo_status: "QUITADO", numero_acordo: 1348, saldo_acordo: 0, valor_acordo: 4381.2,
      quitado_em: "2026-09-01", acordos_com_parcela_paga: 0, valor_pago: 4516.76, ultimo_pagamento: "2026-07-17",
    },
  ],
};

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: RESPOSTA, error: null });
});
afterEach(cleanup);

describe("MensalidadesAVincular", () => {
  it("mostra o acordo quitado como acordo: card próprio, número, valor pago e data", async () => {
    const contagem = vi.fn();
    await act(async () => { render(<MensalidadesAVincular aoAtualizarContagem={contagem} />); });

    // card da situação nova, com a contagem do resumo
    const card = screen.getByRole("button", { name: /Acordo quitado, mensalidade solta/ });
    expect(card.textContent).toContain("1");

    // o badge da aba soma a situação nova (1 ativo + 1 quitado)
    expect(contagem).toHaveBeenLastCalledWith(2);

    // na linha: o VALOR do acordo (o saldo é zero) e quando quitou -- sem
    // deslocar o dia pelo fuso
    expect(screen.getByText(/nº 1348 · quitado em 01\/09\/2026/)).toBeTruthy();
    expect(screen.getByText(/4\.381,20/)).toBeTruthy();

    // o ativo segue como antes: saldo e "com parcela paga"
    expect(screen.getByText(/nº 10 · com parcela paga/)).toBeTruthy();
  });

  it("filtra pela situação nova ao clicar no card", async () => {
    await act(async () => { render(<MensalidadesAVincular />); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Acordo quitado, mensalidade solta/ }));
    });
    const [nome, args] = rpcMock.mock.calls.at(-1);
    expect(nome).toBe("confirmacao_a_vincular");
    expect(args.p_situacao).toBe("ACORDO_QUITADO");
    expect(args.p_de).toBeNull();
  });
});

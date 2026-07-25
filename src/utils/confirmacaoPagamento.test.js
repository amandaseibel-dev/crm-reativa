import { describe, it, expect } from "vitest";
import { planejarAcoesConfirmacao } from "./confirmacaoPagamento";

describe("planejarAcoesConfirmacao", () => {
  it("pagamento confirmado com SALDO ABERTO (quitou=false): registra recebimento, NÃO quita, mantém na carteira, sem reposição", () => {
    const res = { quitou: false, motivo: "SALDO_PENDENTE", detalhe: { total: 350 } };
    const plano = planejarAcoesConfirmacao(res, null);
    expect(plano.registrarRecebimento).toBe(true);
    expect(plano.quitarAluno).toBe(false);
    expect(plano.permitirReposicao).toBe(false);
    expect(plano.manterNaCarteira).toBe(true);
    expect(plano.saldoPendente).toBe(true);
  });

  it("pagamento confirmado com SALDO ZERADO (quitou=true): quita aluno/caso, sai da fila, permite reposição", () => {
    const res = { quitou: true, detalhe: { total: 0 } };
    const plano = planejarAcoesConfirmacao(res, null);
    expect(plano.registrarRecebimento).toBe(true);
    expect(plano.quitarAluno).toBe(true);
    expect(plano.permitirReposicao).toBe(true);
    expect(plano.manterNaCarteira).toBe(false);
    expect(plano.saldoPendente).toBe(false);
  });

  it("ACORDO ATIVO / saldo do acordo em aberto (quitou=false): mantém caso, sem quitação e sem reposição", () => {
    // A RPC devolve quitou=false quando ainda há parcelas de acordo em aberto.
    const res = { quitou: false, motivo: "SALDO_PENDENTE", detalhe: { parcelas_abertas_qtd: 5 } };
    const plano = planejarAcoesConfirmacao(res, null);
    expect(plano.quitarAluno).toBe(false);
    expect(plano.permitirReposicao).toBe(false);
    expect(plano.manterNaCarteira).toBe(true);
  });

  it("NENHUMA reposição quando quitou !== true (erro, null, ausente ou não-booleano)", () => {
    const casos = [
      planejarAcoesConfirmacao(null, new Error("rpc falhou")), // erro na RPC
      planejarAcoesConfirmacao(null, null), // sem retorno
      planejarAcoesConfirmacao({}, null), // quitou ausente
      planejarAcoesConfirmacao({ quitou: "true" }, null), // string, não booleano
      planejarAcoesConfirmacao({ quitou: 1 }, null), // número, não booleano
    ];
    for (const plano of casos) {
      expect(plano.permitirReposicao).toBe(false);
      expect(plano.quitarAluno).toBe(false);
      expect(plano.manterNaCarteira).toBe(true);
      // recebimento continua sendo registrado mesmo quando não quita
      expect(plano.registrarRecebimento).toBe(true);
    }
  });
});

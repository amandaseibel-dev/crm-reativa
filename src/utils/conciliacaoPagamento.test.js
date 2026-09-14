// A fila deixou de ser "sem aluno" e virou "nao baixou". O que este teste
// protege e a consequencia disso na tela: linha com aluno JA identificado
// entra na fila, mas NAO pode oferecer "Vincular" -- vincular ali so daria a
// chance de sobrescrever um vinculo correto por boleto exato.
//
// O fixture sao as seis classes reais do arquivo Santander de 14/09/2026.
import { describe, it, expect } from "vitest";
import {
  STATUS_CONCILIACAO,
  SEM_ESTADO,
  estadoDaLinha,
  podeVincularAluno,
  contarPorStatus,
} from "./conciliacaoPagamento";

// Uma linha por classe apurada, com o que a RPC devolve para a tela.
const FILA = [
  { pagamento_id: "a", status_conciliacao: "AGUARDANDO_ACORDO", tem_aluno: false, valor_pago: 566.67 },
  { pagamento_id: "b", status_conciliacao: "AGUARDANDO_AMARRACAO", tem_aluno: true, valor_pago: 534.23 },
  { pagamento_id: "c", status_conciliacao: "PARCELA_JA_PAGA", tem_aluno: true, valor_pago: 228.87 },
  { pagamento_id: "d", status_conciliacao: "REVISAO", tem_aluno: true, valor_pago: 419.74 },
  { pagamento_id: "e", status_conciliacao: "SEM_VINCULO", tem_aluno: false, valor_pago: 80.36 },
  // linha anterior a 14/09: entrou sem a coluna e a tela nao pode inventar estado
  { pagamento_id: "f", status_conciliacao: null, tem_aluno: false, valor_pago: 12.5 },
];

describe("estado da linha", () => {
  it("cada um dos cinco estados pendentes tem rotulo proprio", () => {
    for (const chave of [
      "AGUARDANDO_ACORDO",
      "AGUARDANDO_AMARRACAO",
      "PARCELA_JA_PAGA",
      "REVISAO",
      "SEM_VINCULO",
    ]) {
      expect(STATUS_CONCILIACAO[chave].rotulo).toBeTruthy();
      expect(STATUS_CONCILIACAO[chave].explica).toBeTruthy();
    }
  });

  it("BAIXADO existe no vocabulario, mas nao e pendencia", () => {
    expect(STATUS_CONCILIACAO.BAIXADO.rotulo).toBe("Baixado");
  });

  it("linha anterior a regra nao ganha estado inventado", () => {
    expect(estadoDaLinha(FILA[5])).toBe(SEM_ESTADO);
    expect(estadoDaLinha({ status_conciliacao: "QUALQUER_COISA" })).toBe(SEM_ESTADO);
    expect(estadoDaLinha(undefined)).toBe(SEM_ESTADO);
  });

  it("traduz o estado gravado", () => {
    expect(estadoDaLinha(FILA[1]).rotulo).toBe("Aguardando amarração");
  });
});

describe("quem pode receber Vincular", () => {
  it("so as linhas sem aluno", () => {
    expect(FILA.filter(podeVincularAluno).map((l) => l.pagamento_id)).toEqual(["a", "e", "f"]);
  });

  it("as tres com aluno identificado nao oferecem vinculo", () => {
    for (const id of ["b", "c", "d"]) {
      const linha = FILA.find((l) => l.pagamento_id === id);
      expect(podeVincularAluno(linha)).toBe(false);
    }
  });

  it("a ausencia do campo nao libera vinculo por acidente", () => {
    expect(podeVincularAluno({ tem_aluno: undefined })).toBe(true);
    expect(podeVincularAluno({ tem_aluno: true })).toBe(false);
  });
});

describe("contagem por estado", () => {
  it("conta cada estado uma vez e agrupa o historico em SEM_ESTADO", () => {
    expect(contarPorStatus(FILA)).toEqual({
      AGUARDANDO_ACORDO: 1,
      AGUARDANDO_AMARRACAO: 1,
      PARCELA_JA_PAGA: 1,
      REVISAO: 1,
      SEM_VINCULO: 1,
      SEM_ESTADO: 1,
    });
  });

  it("lista vazia nao quebra", () => {
    expect(contarPorStatus([])).toEqual({});
    expect(contarPorStatus(null)).toEqual({});
  });
});

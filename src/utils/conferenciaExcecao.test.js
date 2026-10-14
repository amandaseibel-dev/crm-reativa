// O que esta suíte protege: a fronteira entre "um clique" e "precisa análise".
// Se ela escorregar para o lado errado, ou a tela volta a pedir confirmação
// para tudo (o problema que o PR #673 começou a resolver), ou -- muito pior --
// uma linha que QUITA o caso passa a quitar com um clique só.
import { describe, it, expect } from "vitest";
import { ehExcecao, excecoesDaLinha } from "./conferenciaExcecao";

const NORMAL = {
  tipo: "COM_ALUNO", aluno_id: "a1", nome: "Jose", cpf: "123",
  entrou: 500, baixado: 0, saldo_aberto: 1200,
  ultimo_pagamento: "2026-10-10", quitado_em: null, em_confirmacao: 0,
};

describe("conferência: um clique x análise", () => {
  it("pagamento normal com saldo em aberto não é exceção", () => {
    expect(ehExcecao(NORMAL)).toBe(false);
    expect(excecoesDaLinha(NORMAL)).toEqual([]);
  });

  it("saldo zerado é exceção -- é a linha que quitaria o caso", () => {
    const l = { ...NORMAL, saldo_aberto: 0 };
    expect(excecoesDaLinha(l).map((x) => x.chave)).toContain("QUITARIA");
  });

  it("saldo de centavos abaixo do epsilon também conta como zerado", () => {
    expect(excecoesDaLinha({ ...NORMAL, saldo_aberto: 0.004 }).map((x) => x.chave)).toContain("QUITARIA");
  });

  it("sem vínculo é exceção e encerra a lista: achar o dono vem antes", () => {
    const l = { ...NORMAL, tipo: "SEM_VINCULO", aluno_id: null, saldo_aberto: 0 };
    expect(excecoesDaLinha(l)).toHaveLength(1);
    expect(excecoesDaLinha(l)[0].chave).toBe("SEM_VINCULO");
  });

  it("cadastro vinculado sem CPF é exceção: identidade vem antes do dinheiro", () => {
    expect(excecoesDaLinha({ ...NORMAL, cpf: null }).map((x) => x.chave)).toContain("SEM_CPF");
    expect(excecoesDaLinha({ ...NORMAL, cpf: "   " }).map((x) => x.chave)).toContain("SEM_CPF");
    expect(excecoesDaLinha({ ...NORMAL, cpf: "111.222.333-44" }).map((x) => x.chave)).not.toContain("SEM_CPF");
  });

  it("sem data de pagamento é exceção: a trava da RPC compara aluno, data e valor", () => {
    // com data nula a RPC compara NULL = NULL, nunca casa, e cada clique cria
    // uma baixa nova. E o caso de baixa em dobro mais silencioso que existe.
    expect(excecoesDaLinha({ ...NORMAL, ultimo_pagamento: null }).map((x) => x.chave)).toContain("SEM_DATA");
  });

  it("baixa prévia na janela é exceção mesmo quando a soma bate", () => {
    // duas baixas de 250 somam os 500 que entraram: a soma "confere", mas a
    // trava da RPC procura UMA baixa de 500 na mesma data e nao acha nenhuma.
    const l = { ...NORMAL, entrou: 500, baixado: 500 };
    expect(excecoesDaLinha(l).map((x) => x.chave)).toContain("JA_TEM_BAIXA");
    expect(ehExcecao(l)).toBe(true);
  });

  it("nada no extrato e nada baixado é exceção: a RPC recusa valor zero", () => {
    expect(excecoesDaLinha({ ...NORMAL, entrou: 0, baixado: 0 }).map((x) => x.chave)).toContain("SEM_VALOR");
  });

  it("baixa sem lastro no extrato é exceção", () => {
    const l = { ...NORMAL, entrou: 0, baixado: 300 };
    expect(excecoesDaLinha(l).map((x) => x.chave)).toContain("SEM_LASTRO");
  });

  it("baixa diferente do extrato é exceção", () => {
    const l = { ...NORMAL, entrou: 500, baixado: 430 };
    expect(excecoesDaLinha(l).map((x) => x.chave)).toContain("DIVERGE");
  });

  it("diferença de centavos não vira divergência -- mas a baixa prévia ainda barra", () => {
    const l = { ...NORMAL, entrou: 500, baixado: 500.04 };
    expect(excecoesDaLinha(l).map((x) => x.chave)).not.toContain("DIVERGE");
    expect(excecoesDaLinha(l).map((x) => x.chave)).toContain("JA_TEM_BAIXA");
  });

  it("pagamento depois da quitação é exceção", () => {
    const l = { ...NORMAL, quitado_em: "2026-09-01", ultimo_pagamento: "2026-10-10" };
    expect(excecoesDaLinha(l).map((x) => x.chave)).toContain("DEPOIS_DE_QUITAR");
  });

  it("pagamento antes da quitação não é exceção por isso", () => {
    const l = { ...NORMAL, quitado_em: "2026-10-20", ultimo_pagamento: "2026-10-10" };
    expect(excecoesDaLinha(l).map((x) => x.chave)).not.toContain("DEPOIS_DE_QUITAR");
  });

  it("mensalidade em confirmação é exceção", () => {
    const l = { ...NORMAL, em_confirmacao: 820.5 };
    expect(excecoesDaLinha(l).map((x) => x.chave)).toContain("EM_CONFIRMACAO");
  });

  it("acumula motivos quando a linha tem mais de um problema", () => {
    const l = { ...NORMAL, saldo_aberto: 0, entrou: 500, baixado: 100, quitado_em: "2026-01-01" };
    expect(excecoesDaLinha(l).map((x) => x.chave).sort())
      .toEqual(["DEPOIS_DE_QUITAR", "DIVERGE", "QUITARIA"]);
  });

  it("linha vazia não derruba a regra", () => {
    expect(ehExcecao(undefined)).toBe(true);
    expect(excecoesDaLinha(null)[0].chave).toBe("SEM_VINCULO");
  });
});

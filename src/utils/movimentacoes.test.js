import { describe, it, expect } from "vitest";
import {
  LIMITE_MOVIMENTACOES_VISIVEIS,
  corMovimentacao,
  resumoStatus,
  rotuloOperador,
  recortarMovimentacoes,
} from "./movimentacoes";

// O recorte é só de exibição: a garantia que importa é que ele nunca perde
// registro — a lista completa continua inteira para "Ver todas" e para o PDF.
const lista = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, tipo: "ACIONAMENTO" }));

describe("recortarMovimentacoes", () => {
  it("mostra tudo quando a lista cabe no limite", () => {
    const r = recortarMovimentacoes(lista(10), false);
    expect(r.visiveis).toHaveLength(10);
    expect(r.ocultas).toBe(0);
    expect(r.podeExpandir).toBe(false);
  });

  it("corta no limite e informa quantas ficaram ocultas", () => {
    const r = recortarMovimentacoes(lista(27), false);
    expect(r.visiveis).toHaveLength(LIMITE_MOVIMENTACOES_VISIVEIS);
    expect(r.total).toBe(27);
    expect(r.ocultas).toBe(17);
    expect(r.podeExpandir).toBe(true);
  });

  it("devolve as mais recentes primeiro, sem reordenar a origem", () => {
    const origem = lista(15);
    const r = recortarMovimentacoes(origem, false);
    expect(r.visiveis[0].id).toBe(1);
    expect(r.visiveis.at(-1).id).toBe(10);
    expect(origem).toHaveLength(15);
  });

  it("expandido devolve a lista completa", () => {
    const r = recortarMovimentacoes(lista(27), true);
    expect(r.visiveis).toHaveLength(27);
    expect(r.ocultas).toBe(0);
    expect(r.podeExpandir).toBe(true);
  });

  it("aguenta lista vazia ou ausente", () => {
    expect(recortarMovimentacoes([], false).visiveis).toEqual([]);
    expect(recortarMovimentacoes(null, false).total).toBe(0);
    expect(recortarMovimentacoes(undefined, true).podeExpandir).toBe(false);
  });
});

describe("resumoStatus", () => {
  it("monta a transição em uma linha", () => {
    expect(resumoStatus("LINK_PRONTO_PARA_ENVIO", "LINK_ENVIADO_AO_ALUNO")).toBe(
      "LINK_PRONTO_PARA_ENVIO → LINK_ENVIADO_AO_ALUNO",
    );
  });

  it("some quando não há transição alguma", () => {
    expect(resumoStatus(null, null)).toBe("");
    expect(resumoStatus("", "   ")).toBe("");
  });

  it("mostra só o lado preenchido quando um dos dois falta", () => {
    expect(resumoStatus(null, "LINK_PRONTO_PARA_ENVIO")).toBe("LINK_PRONTO_PARA_ENVIO");
    expect(resumoStatus("AGUARDANDO_BAIXA", null)).toBe("AGUARDANDO_BAIXA");
  });

  it("não repete o mesmo status dos dois lados", () => {
    expect(resumoStatus("CONTATAR", "CONTATAR")).toBe("CONTATAR");
  });
});

describe("rotuloOperador", () => {
  it("usa o nome e deixa o e-mail fora da linha", () => {
    expect(rotuloOperador("Nataly", "cobranca08@aelbra.com.br")).toBe("Nataly");
  });

  it("cai para o e-mail quando não há nome — a chave não se perde", () => {
    expect(rotuloOperador("", "cobranca08@aelbra.com.br")).toBe("cobranca08@aelbra.com.br");
  });

  it("devolve vazio quando não há nem nome nem e-mail", () => {
    expect(rotuloOperador(null, null)).toBe("");
  });
});

describe("corMovimentacao", () => {
  it("classifica pagamento e baixa em verde", () => {
    expect(corMovimentacao("COMPROVANTE_ENVIADO_BAIXA", "AGUARDANDO_BAIXA")).not.toBe("#2563eb");
    expect(corMovimentacao("PAGAMENTO_CONFIRMADO", null)).toBe("#16a34a");
  });

  it("classifica cancelamento e rejeição em vermelho", () => {
    expect(corMovimentacao("ACORDO_CANCELADO", null)).toBe("#dc2626");
    expect(corMovimentacao("REJEITADO", null)).toBe("#dc2626");
  });

  it("usa o status novo como desempate quando o tipo não diz nada", () => {
    expect(corMovimentacao("MOVIMENTACAO", "AGUARDANDO_BAIXA")).toBe("#d97706");
  });

  it("devolve o azul padrão sem correspondência ou sem dado", () => {
    expect(corMovimentacao("ALGO_QUE_NAO_EXISTE", null)).toBe("#2563eb");
    expect(corMovimentacao(null, null)).toBe("#2563eb");
  });
});

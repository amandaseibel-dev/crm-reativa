import { describe, it, expect } from "vitest";
import { ESTADO, estadoDoTitulo, rotuloDoTitulo, contaComoAberta, precisaDeSaida } from "./estadoTitulo";

// COMPORTAMENTO DE CADA ESTADO DE MENSALIDADE.
//
// Cada caso abaixo e um estado que existe em producao hoje (medido em
// 23/09/2026): ABERTO 38.361, PAGO 5.323, NEGOCIADO 3.132, EM_CONFIRMACAO 668,
// CANCELADA 349, DUPLICADA 135.
//
// A regua e a fonte canonica `aluno_saldo_pendente_detalhe`, que conta como
// divida apenas `situacao in ('ABERTO','NEGOCIADO')`. Conferido contra
// recalcular_situacao_aluno, acoes_massivas_universo,
// buscar_candidatos_acoes_massivas e titulos_disponiveis_para_acordo: as cinco
// concordam que CANCELADA e DUPLICADA ficam fora de saldo, fila e acordo.

const t = (o) => ({ situacao: "ABERTO", status: "em_aberto", acordo_id: null, ...o });

describe("estado da mensalidade", () => {
  it("ABERTO: conta como divida e nao precisa de saida", () => {
    const x = t();
    expect(estadoDoTitulo(x)).toBe(ESTADO.ABERTO);
    expect(rotuloDoTitulo(x)).toBe("Em aberto");
    expect(contaComoAberta(x)).toBe(true);
    expect(precisaDeSaida(x)).toBe(false);
  });

  it("NEGOCIADO: sai da conta de mensalidade (a divida vive nas parcelas do acordo)", () => {
    for (const x of [
      t({ situacao: "NEGOCIADO", status: "vinculada", acordo_id: "a1" }),
      t({ situacao: "NEGOCIADO", status: "em_aberto" }),       // gatilho ainda nao rodou
      t({ situacao: "ABERTO", status: "em_aberto", acordo_id: "a1" }), // so o ponteiro
    ]) {
      expect(estadoDoTitulo(x)).toBe(ESTADO.NEGOCIADO);
      expect(contaComoAberta(x)).toBe(false);
      expect(precisaDeSaida(x)).toBe(false); // desvincular ja e a saida existente
    }
    expect(rotuloDoTitulo(t({ situacao: "NEGOCIADO" }))).toBe("Negociado");
  });

  it("EM_CONFIRMACAO: fora da conta E precisa de saida explicita", () => {
    const x = t({ situacao: "EM_CONFIRMACAO", status: "em_confirmacao" });
    expect(estadoDoTitulo(x)).toBe(ESTADO.EM_CONFIRMACAO);
    expect(rotuloDoTitulo(x)).toBe("Em confirmação");
    expect(contaComoAberta(x)).toBe(false);
    // 668 titulos / R$ 1.562.838,14 que ficavam sem caminho nenhum
    expect(precisaDeSaida(x)).toBe(true);
  });

  it("DUPLICADA: fora da conta E precisa de saida -- o rotulo ja dizia, a contagem nao", () => {
    // O bug que isto trava: status continua 'em_aberto', entao qualquer filtro
    // que olhe so o status conta a duplicada como divida.
    const x = t({ situacao: "DUPLICADA", status: "em_aberto" });
    expect(estadoDoTitulo(x)).toBe(ESTADO.DUPLICADA);
    expect(rotuloDoTitulo(x)).toBe("Fora da conta");
    expect(contaComoAberta(x)).toBe(false);
    expect(precisaDeSaida(x)).toBe(true);
  });

  it("CANCELADA: fora da conta e nunca rotulada como 'Em aberto'", () => {
    for (const x of [
      t({ situacao: "CANCELADA", status: "cancelada" }),
      t({ situacao: "CANCELADA", status: "em_aberto" }),  // so a situacao
      t({ situacao: "ABERTO", status: "cancelada" }),     // so o status
    ]) {
      expect(estadoDoTitulo(x)).toBe(ESTADO.CANCELADA);
      expect(rotuloDoTitulo(x)).not.toBe("Em aberto");
      expect(contaComoAberta(x)).toBe(false);
    }
    expect(rotuloDoTitulo(t({ situacao: "CANCELADA" }))).toBe("Cancelada");
  });

  it("PAGO ganha de tudo: quitada com acordo continua quitada", () => {
    for (const x of [
      t({ situacao: "PAGO", status: "quitada", acordo_id: "a1" }),
      t({ situacao: "PAGO", status: "em_aberto" }),
      t({ situacao: "ABERTO", status: "quitada" }),
    ]) {
      expect(estadoDoTitulo(x)).toBe(ESTADO.PAGO);
      expect(contaComoAberta(x)).toBe(false);
    }
    expect(rotuloDoTitulo(t({ situacao: "PAGO" }))).toBe("Quitada");
  });

  it("a ordem dos testes e a regra: terminal antes de negociado", () => {
    // Foi exatamente isto que fazia o cancelado virar "Em aberto": ele nao
    // tinha ramo e caia no fim da cadeia.
    expect(estadoDoTitulo(t({ situacao: "CANCELADA", acordo_id: "a1" }))).toBe(ESTADO.CANCELADA);
    expect(estadoDoTitulo(t({ situacao: "DUPLICADA", acordo_id: "a1" }))).toBe(ESTADO.DUPLICADA);
    expect(estadoDoTitulo(t({ situacao: "EM_CONFIRMACAO", acordo_id: "a1" }))).toBe(ESTADO.EM_CONFIRMACAO);
  });

  it("campo ausente ou nulo nao vira divida por acidente", () => {
    expect(estadoDoTitulo({})).toBe(ESTADO.ABERTO);
    expect(estadoDoTitulo(null)).toBe(ESTADO.ABERTO);
    expect(estadoDoTitulo(t({ situacao: null, status: null }))).toBe(ESTADO.ABERTO);
    // minusculo/maiusculo nao pode mudar o estado
    expect(estadoDoTitulo(t({ situacao: "cancelada" }))).toBe(ESTADO.CANCELADA);
    expect(estadoDoTitulo(t({ status: "QUITADA" }))).toBe(ESTADO.PAGO);
  });
});

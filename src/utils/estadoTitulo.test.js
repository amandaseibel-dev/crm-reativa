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

// DEVOLVIDO -- a tabulacao que encerra o saldo sem recuperacao pela ReATIVA.
//
// Antes de 08/10/2026 o motor gravava CANCELADA nestes casos, e o front mostrava
// "Cancelada". As duas causas tem o MESMO efeito no saldo e significados
// OPOSTOS para quem le a ficha: cancelada e "nao era nossa"; devolvida e "era
// nossa e a gestao devolveu sem receber". Os 19 titulos do backfill de 08/10
// (R$ 133.089,35) sao devolucao; os 29 da Conferencia Prime (R$ 286.319,45)
// seguem cancelamento.
describe("estado da mensalidade: DEVOLVIDO", () => {
  it("fica fora da conta e tem rotulo proprio, distinto de cancelada", () => {
    for (const x of [
      t({ situacao: "DEVOLVIDO", status: "devolvido" }),
      t({ situacao: "DEVOLVIDO", status: "em_aberto" }), // gatilho de coerencia ainda nao rodou
      t({ situacao: "ABERTO", status: "devolvido" }),    // so o status chegou
    ]) {
      expect(estadoDoTitulo(x)).toBe(ESTADO.DEVOLVIDO);
      expect(contaComoAberta(x)).toBe(false);
      expect(precisaDeSaida(x)).toBe(false); // e desfecho, nao espera decisao
    }
    expect(rotuloDoTitulo(t({ situacao: "DEVOLVIDO", status: "devolvido" })))
      .toBe("Devolvida sem recuperação");
  });

  it("nao se confunde com CANCELADA: rotulos diferentes para causas diferentes", () => {
    const devolvido = t({ situacao: "DEVOLVIDO", status: "devolvido" });
    const cancelado = t({ situacao: "CANCELADA", status: "cancelada" });

    expect(estadoDoTitulo(devolvido)).not.toBe(estadoDoTitulo(cancelado));
    expect(rotuloDoTitulo(devolvido)).not.toBe(rotuloDoTitulo(cancelado));
    expect(rotuloDoTitulo(cancelado)).toBe("Cancelada");
    // mas o efeito no saldo e o mesmo: nenhum dos dois conta
    expect(contaComoAberta(devolvido)).toBe(false);
    expect(contaComoAberta(cancelado)).toBe(false);
  });

  it("nao e lido como pagamento nem recuperacao", () => {
    const devolvido = t({ situacao: "DEVOLVIDO", status: "devolvido" });
    expect(estadoDoTitulo(devolvido)).not.toBe(ESTADO.PAGO);
    expect(rotuloDoTitulo(devolvido)).not.toMatch(/quitad/i);
    expect(rotuloDoTitulo(devolvido)).toMatch(/sem recupera/i);
  });

  it("pago continua ganhando de devolvido: pagamento real e terminal primeiro", () => {
    // se os dois carimbos brigarem, o pagamento vence -- dinheiro que entrou
    // nao pode ser reescrito por um desfecho administrativo
    expect(estadoDoTitulo(t({ situacao: "DEVOLVIDO", status: "quitada" }))).toBe(ESTADO.PAGO);
    expect(estadoDoTitulo(t({ situacao: "PAGO", status: "devolvido" }))).toBe(ESTADO.PAGO);
  });
});

// SUSPENSO -- o único estado terminal que VOLTA.
//
// Sai da conta como DEVOLVIDO e CANCELADA, mas por motivo oposto: a dívida
// continua sendo nossa e a cobrança apenas parou. O rótulo tem de dizer isso,
// senão o operador lê "suspensa" como desfecho e para de acompanhar.
describe("estado da mensalidade: SUSPENSO", () => {
  it("fica fora da conta, com rótulo que fala de cobrança e não de desfecho", () => {
    for (const x of [
      t({ situacao: "SUSPENSO", status: "suspenso" }),
      t({ situacao: "SUSPENSO", status: "em_aberto" }), // coerência ainda não rodou
      t({ situacao: "ABERTO", status: "suspenso" }),
    ]) {
      expect(estadoDoTitulo(x)).toBe(ESTADO.SUSPENSO);
      expect(contaComoAberta(x)).toBe(false);
      expect(precisaDeSaida(x)).toBe(false); // a saída é levantar a suspensão
    }
    expect(rotuloDoTitulo(t({ situacao: "SUSPENSO", status: "suspenso" })))
      .toBe("Cobrança suspensa");
  });

  it("não se confunde com devolvida nem com cancelada", () => {
    const s = t({ situacao: "SUSPENSO", status: "suspenso" });
    const d = t({ situacao: "DEVOLVIDO", status: "devolvido" });
    const c = t({ situacao: "CANCELADA", status: "cancelada" });
    const rotulos = new Set([rotuloDoTitulo(s), rotuloDoTitulo(d), rotuloDoTitulo(c)]);
    expect(rotulos.size).toBe(3);
    expect(new Set([estadoDoTitulo(s), estadoDoTitulo(d), estadoDoTitulo(c)]).size).toBe(3);
  });

  it("não é lido como pagamento nem recuperação", () => {
    const s = t({ situacao: "SUSPENSO", status: "suspenso" });
    expect(estadoDoTitulo(s)).not.toBe(ESTADO.PAGO);
    expect(rotuloDoTitulo(s)).not.toMatch(/quitad|recupera/i);
  });

  it("pagamento real vence a suspensão", () => {
    expect(estadoDoTitulo(t({ situacao: "SUSPENSO", status: "quitada" }))).toBe(ESTADO.PAGO);
    expect(estadoDoTitulo(t({ situacao: "PAGO", status: "suspenso" }))).toBe(ESTADO.PAGO);
  });
});

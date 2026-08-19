// Tradução do ack do WhatsApp para o nosso vocabulário de status.
//
// POR QUE ESTE ARQUIVO EXISTE: até 19/08/2026 o operador via "ENVIADO" e lia
// "o aluno recebeu". Não era. O status era gravado uma vez, quando a mensagem
// entrava na fila, e nunca mais mudava — 1.075 mensagens marcadas como enviadas
// sem uma única confirmação de entrega por trás.
//
// Os valores testados aqui não são o que a documentação promete: são os que a
// instrumentação mediu nesta sessão, com mensagens reais.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DADOS_DIR = mkdtempSync(join(tmpdir(), "wa-ack-"));
process.env.CRM_URL = "http://127.0.0.1:1";
process.env.CRM_SEGREDO = "x".repeat(64);
process.env.GATEWAY_TOKEN = "y".repeat(64);
process.env.SESSOES = "piloto";

const { statusDoAck } = await import("./sessao.js");

describe("statusDoAck — o que o Baileys manda x o que gravamos", () => {
  test("2 SERVER_ACK vira ACEITA_PELO_WHATSAPP, nunca ENTREGUE", () => {
    // A distinção inteira do trabalho está nesta linha: o WhatsApp ter aceitado
    // não é o aluno ter recebido.
    assert.equal(statusDoAck(2), "ACEITA_PELO_WHATSAPP");
  });

  test("3 DELIVERY_ACK vira ENTREGUE", () => {
    assert.equal(statusDoAck(3), "ENTREGUE");
  });

  test("4 READ vira LIDA", () => {
    assert.equal(statusDoAck(4), "LIDA");
  });

  test("5 PLAYED vira LIDA: quem ouviu o audio, abriu", () => {
    assert.equal(statusDoAck(5), "LIDA");
  });

  test("1 PENDING vira PENDENTE", () => {
    assert.equal(statusDoAck(1), "PENDENTE");
  });

  // -------------------------------------------------------------------------
  // A regra que o produto EXIGIU: nada de presumir falha.
  // -------------------------------------------------------------------------
  test("0 ERROR NAO vira FALHOU — falha so com erro confirmado do sendMessage", () => {
    // Este valor nunca foi observado em produção. Marcar mensagem como falhada
    // por um código que ninguém viu acontecer seria inventar estado. Fica null:
    // o status atual da mensagem não é tocado.
    assert.equal(statusDoAck(0), null);
  });

  test("valor desconhecido nao inventa status", () => {
    // Se o WhatsApp passar a mandar um código novo, o certo é NÃO mexer no
    // status até alguém olhar o log e decidir com evidência.
    assert.equal(statusDoAck(9), null);
    assert.equal(statusDoAck(null), null);
    assert.equal(statusDoAck(undefined), null);
  });
});

describe("statusDoAck — o que foi medido em producao", () => {
  // Sequência real da mensagem de teste 3EB0F646ACAAB719B59C42, celular online:
  //   22:23:17 status 3  DELIVERY_ACK
  //   22:23:17 status 3  DELIVERY_ACK   (repetido)
  //   22:23:17 status 4  READ
  //   22:23:17 status 3  DELIVERY_ACK   (repetido, DEPOIS do READ)
  const SEQUENCIA_REAL = [3, 3, 4, 3];

  test("a sequencia real traduz sem nenhum buraco", () => {
    const traduzida = SEQUENCIA_REAL.map(statusDoAck);
    assert.deepEqual(traduzida, ["ENTREGUE", "ENTREGUE", "LIDA", "ENTREGUE"]);
    assert.ok(traduzida.every(Boolean), "nenhum ack real pode virar null");
  });

  test("o ultimo ack real e um ENTREGUE que chega DEPOIS do LIDA", () => {
    // É este caso que a trava monotônica do banco precisa segurar: sem ela, a
    // mensagem já lida voltaria para "entregue" na tela do operador.
    const traduzida = SEQUENCIA_REAL.map(statusDoAck);
    assert.equal(traduzida[2], "LIDA");
    assert.equal(traduzida[3], "ENTREGUE");
  });

  test("entrega sem aceite e caminho normal, nao anomalia", () => {
    // Nenhuma das mensagens observadas passou por SERVER_ACK antes do
    // DELIVERY_ACK. O modelo tem que aceitar ENTREGUE sem ACEITA_PELO_WHATSAPP.
    assert.equal(statusDoAck(3), "ENTREGUE");
    assert.notEqual(statusDoAck(3), null);
  });
});

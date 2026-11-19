// O QUE VIRA TRACINHO NA CENTRAL E O QUE NÃO VIRA.
//
// "Enviado" na Central significava só "entrou na nossa fila". O operador lia
// isso como "o aluno recebeu". Estes testes travam a tradução do recibo do
// WhatsApp para os dois estados que respondem à pergunta de verdade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { statusDoAck, statusDoRecibo, eventoDeStatus, ENTREGUE, LIDO } from "./recibos.js";

test("ack de entrega vira ENTREGUE; de leitura e de áudio ouvido viram LIDO", () => {
  assert.equal(statusDoAck(3), ENTREGUE);
  assert.equal(statusDoAck(4), LIDO);
  assert.equal(statusDoAck(5), LIDO);
});

test("ack que ainda não é o aluno não vira status", () => {
  assert.equal(statusDoAck(1), null); // PENDING
  assert.equal(statusDoAck(2), null); // SERVER_ACK: o servidor aceitou, só isso
});

test("ack de erro não pinta a mensagem de falha por este caminho", () => {
  assert.equal(statusDoAck(0), null);
});

test("update sem status (edição, reação, enquete) não vira status", () => {
  assert.equal(statusDoAck(undefined), null);
  assert.equal(statusDoAck(null), null);
  assert.equal(statusDoAck("READ"), null);
  assert.equal(statusDoAck(99), null);
});

test("recibo com carimbo de leitura ganha do de entrega", () => {
  assert.equal(statusDoRecibo({ receiptTimestamp: 1 }), ENTREGUE);
  assert.equal(statusDoRecibo({ receiptTimestamp: 1, readTimestamp: 2 }), LIDO);
  assert.equal(statusDoRecibo({ playedTimestamp: 3 }), LIDO);
});

test("recibo vazio não vira status", () => {
  assert.equal(statusDoRecibo(null), null);
  assert.equal(statusDoRecibo({}), null);
  assert.equal(statusDoRecibo({ userJid: "x@lid" }), null);
});

test("evento só existe com sessão, wamid e status — e não carrega telefone", () => {
  assert.deepEqual(
    eventoDeStatus({ sessao: "cobranca", wamid: "3EB0ABC", status: LIDO }),
    { sessao: "cobranca", wamid: "3EB0ABC", status: LIDO },
  );
  assert.equal(eventoDeStatus({ sessao: "cobranca", wamid: "3EB0ABC", status: null }), null);
  assert.equal(eventoDeStatus({ sessao: "cobranca", wamid: null, status: LIDO }), null);
  assert.equal(eventoDeStatus({ sessao: null, wamid: "3EB0ABC", status: LIDO }), null);
});

// O `lid-mapping` da credencial precisa virar vínculo LID->telefone ANTES do
// histórico ser processado.
//
// POR QUE ESTE ARQUIVO EXISTE: no pareamento do Comercial em 20/08/2026, o
// WhatsApp entregou o histórico e o gateway reteve 39.455 mensagens de 899
// contatos por "LID sem vínculo". Minutos depois, a credencial em disco tinha
// 1.805 pares LID<->telefone cobrindo os 899 — a informação existia, só não era
// lida. O histórico só é oferecido UMA VEZ por pareamento.
//
// Os formatos abaixo foram copiados da credencial real do Comercial.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { VinculosLid, resolverEndereco } from "./enderecos.js";

// Como a Baileys 7 grava: as duas direções, usuário cru, sem domínio.
const STORE_REAL = {
  "lid-mapping": {
    "555199154925": "173310721683688",              // telefone -> LID
    "173310721683688_reverse": "555199154925",      // LID -> telefone
    "556392431881": "172138514366591",
    "172138514366591_reverse": "556392431881",
  },
};

describe("aprenderDoStore", () => {
  test("aproveita o vinculo que a credencial ja tinha", () => {
    const v = new VinculosLid();
    assert.equal(v.tamanho, 0);
    const novos = v.aprenderDoStore(STORE_REAL);
    assert.ok(novos >= 2, `esperava ao menos 2 vinculos, veio ${novos}`);
    assert.equal(v.resolver("173310721683688@lid"), "555199154925");
    assert.equal(v.resolver("172138514366591@lid"), "556392431881");
  });

  test("as duas direcoes levam ao mesmo par - nao duplica", () => {
    const v = new VinculosLid();
    v.aprenderDoStore(STORE_REAL);
    assert.equal(v.tamanho, 2, "quatro entradas, dois contatos");
  });

  test("LID DESCONHECIDO continua sem telefone - nada de inferencia", () => {
    const v = new VinculosLid();
    v.aprenderDoStore(STORE_REAL);
    assert.equal(v.resolver("999999999999999@lid"), null);
    // `resolverEndereco` devolve { motivo } SEM a chave telefone quando nao resolve.
    const r = resolverEndereco("999999999999999@lid", v, { id: "X" });
    assert.ok(!r.telefone, "nao pode inventar telefone");
    assert.equal(r.motivo, "LID_SEM_VINCULO", "tem que ficar retido, nao adivinhado");
  });

  test("telefone invalido no store e recusado", () => {
    const v = new VinculosLid();
    // `0` e endereco de sistema, nao pessoa: foi o que congelou a fila em 19/08.
    v.aprenderDoStore({ "lid-mapping": { "111111111111111_reverse": "0" } });
    assert.equal(v.resolver("111111111111111@lid"), null);
  });

  test("store ausente, vazio ou torto nao quebra", () => {
    const v = new VinculosLid();
    assert.equal(v.aprenderDoStore(undefined), 0);
    assert.equal(v.aprenderDoStore(null), 0);
    assert.equal(v.aprenderDoStore({}), 0);
    assert.equal(v.aprenderDoStore({ "lid-mapping": null }), 0);
    assert.equal(v.aprenderDoStore({ "lid-mapping": "nao é objeto" }), 0);
    assert.equal(v.tamanho, 0);
  });

  test("valor com dominio tambem e aceito", () => {
    const v = new VinculosLid();
    v.aprenderDoStore({ "lid-mapping": { "173310721683688_reverse": "555199154925@s.whatsapp.net" } });
    assert.equal(v.resolver("173310721683688@lid"), "555199154925");
  });

  test("o que veio dos lotes NAO e perdido ao semear", () => {
    const v = new VinculosLid();
    v.aprender({ contacts: [{ lid: "888888888888888@lid", jid: "5551988887777@s.whatsapp.net" }] });
    v.aprenderDoStore(STORE_REAL);
    assert.equal(v.resolver("888888888888888@lid"), "5551988887777");
    assert.equal(v.resolver("173310721683688@lid"), "555199154925");
  });
});

describe("o cenario que aconteceu de verdade", () => {
  test("mensagem retida por LID passa a resolver com o store", () => {
    const v = new VinculosLid();
    const chave = { remoteJid: "173310721683688@lid", id: "3A0", fromMe: false };

    // ANTES: sem vinculo, retida (foi o que aconteceu com as 39.455)
    const antes = resolverEndereco(chave.remoteJid, v, chave);
    assert.ok(!antes.telefone);
    assert.equal(antes.motivo, "LID_SEM_VINCULO");

    // DEPOIS de semear da credencial: resolve
    v.aprenderDoStore(STORE_REAL);
    const depois = resolverEndereco(chave.remoteJid, v, chave);
    assert.equal(depois.telefone, "555199154925");
  });
});

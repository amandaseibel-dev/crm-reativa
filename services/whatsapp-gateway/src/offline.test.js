// O QUE CHEGA ENQUANTO O GATEWAY ESTÁ FORA DO AR.
//
// POR QUE ESTE ARQUIVO EXISTE — incidente de 20/08/2026:
//
//   O Mac ficou na bateria e dormiu cinco vezes entre 17:47 e 18:26
//   ('Maintenance Sleep ... Using Batt'), a última por 22 minutos. O WhatsApp
//   segurou as mensagens, como faz, e devolveu tudo no religamento. Só que o
//   Baileys marca o lote acumulado como `append`, e o gateway tinha
//   `if (type !== "notify") return;` — o lote inteiro ia para o lixo sem
//   contador, sem log, sem rastro.
//
//   Uma aluna mandou o CPF às 18:03, dentro da janela. A mensagem nunca
//   apareceu na Central. Ninguém tinha como saber que ela existiu: o CRM não
//   mostrava nem um espaço vazio. Descobriu-se porque a aluna cobrou.
//
// O contrato que estes testes travam é este: mensagem de gente ou entra na
// Central, ou deixa rastro em log e contador. Sumir em silêncio, nunca.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "wa-offline-"));
process.env.DADOS_DIR = base;
process.env.CRM_URL = "http://127.0.0.1:1";
process.env.CRM_SEGREDO = "x".repeat(64);
process.env.GATEWAY_TOKEN = "y".repeat(64);
process.env.SESSOES = "piloto";

const { criarSessao, _usarCrmParaTeste } = await import("./sessao.js");
const { _drenarParaTeste, _usarEntregadorParaTeste } = await import("./outbox.js");

const recebido = [];
_usarCrmParaTeste(async (acao, dados) => {
  if (acao === "sync.abrir") return "sync-de-teste";
  recebido.push({ acao, dados });
  return { ok: true };
});
_usarEntregadorParaTeste(async (acao, dados) => {
  recebido.push({ acao, dados });
  return { ok: true };
});

const TEL = (n) => `55519999${String(n).padStart(5, "0")}@s.whatsapp.net`;

function msg(jid, id, texto) {
  return {
    key: { remoteJid: jid, id, fromMe: false },
    message: { conversation: texto },
    messageTimestamp: 1755600000,
    pushName: "Aluna",
  };
}

// A mensagem que o WhatsApp entrega mas o gateway não consegue abrir. O
// Baileys entrega exatamente assim: `message` nulo e o carimbo CIPHERTEXT.
// Note que `message` nulo também é o formato de um recibo — é justamente essa
// ambiguidade que fazia as duas coisas caírem no mesmo balde.
const CIPHERTEXT = 2; // proto.WebMessageInfo.StubType.CIPHERTEXT
function naoDecifrada(jid, id) {
  return {
    key: { remoteJid: jid, id, fromMe: false },
    message: null,
    messageStubType: CIPHERTEXT,
    messageTimestamp: 1755600000,
  };
}

function recibo(jid, id) {
  return { key: { remoteJid: jid, id, fromMe: false }, message: null, messageTimestamp: 1755600000 };
}

async function drenarTudo(vezes = 20) {
  for (let i = 0; i < vezes; i++) await _drenarParaTeste();
}

const mensagensEntregues = () => recebido.filter((r) => r.acao === "mensagem").map((r) => r.dados);

let sessao;
beforeEach(() => {
  recebido.length = 0;
  for (const d of ["fila", "quarentena"]) {
    if (existsSync(join(base, d))) for (const f of readdirSync(join(base, d))) rmSync(join(base, d, f));
  }
  sessao = criarSessao({ chave: "piloto" });
});

describe("mensagem acumulada enquanto o gateway esteve fora", () => {
  test("1. o CPF das 18:03 — lote `append` entra na Central", async () => {
    // O caso do incidente, reduzido ao osso: exatamente o lote que o Baileys
    // entrega no religamento depois de o Mac dormir.
    sessao._paraTeste.tratarMensagensNovas({
      messages: [msg(TEL(1), "CPF", "meu cpf é 000.000.000-00")],
      type: "append",
    });
    await drenarTudo();

    const m = mensagensEntregues();
    assert.equal(m.length, 1, "o lote acumulado NAO pode ser descartado");
    assert.equal(m[0].texto, "meu cpf é 000.000.000-00");
    assert.equal(m[0].telefone, "5551999900001");
  });

  test("2. `notify` continua entrando igual", async () => {
    sessao._paraTeste.tratarMensagensNovas({
      messages: [msg(TEL(2), "AGORA", "oi")],
      type: "notify",
    });
    await drenarTudo();
    assert.equal(mensagensEntregues().length, 1);
  });

  test("3. lote de tipo desconhecido nao some calado - conta e avisa", async () => {
    sessao._paraTeste.tratarMensagensNovas({
      messages: [msg(TEL(3), "X", "oi")],
      type: "tipo-que-ainda-nao-existe",
    });
    await drenarTudo();

    assert.equal(mensagensEntregues().length, 0, "nao se grava o que nao se entende");
    assert.equal(sessao._paraTeste.descartes().LOTE_IGNORADO, 1, "mas TEM de deixar rastro");
  });

  test("4. o mesmo lote duas vezes nao duplica no que sai daqui", async () => {
    // O religamento pode reentregar o que já entrou. A trava final é o `wamid`
    // UNIQUE no banco (`ON CONFLICT (wamid) DO NOTHING`); aqui só se garante
    // que o gateway manda o MESMO wamid nas duas vezes, que é o que deixa a
    // trava funcionar.
    const lote = { messages: [msg(TEL(4), "REPETIDA", "oi")], type: "append" };
    sessao._paraTeste.tratarMensagensNovas(lote);
    sessao._paraTeste.tratarMensagensNovas(lote);
    await drenarTudo();

    const m = mensagensEntregues();
    assert.equal(m.length, 2, "o gateway reenvia mesmo - quem deduplica e o banco");
    assert.equal(m[0].wamid, m[1].wamid, "o wamid tem de ser igual, senao a trava do banco nao pega");
  });
});

describe("mensagem que chegou e nao foi possivel abrir", () => {
  test("5. CIPHERTEXT nao e recibo - conta separado", async () => {
    // Foi somar as duas coisas no mesmo contador que escondeu 12 mensagens em
    // 20/08. Recibo não tem nada a mostrar; CIPHERTEXT é texto de gente que o
    // WhatsApp entregou e nós não abrimos.
    sessao._paraTeste.tratarMensagensNovas({
      messages: [naoDecifrada(TEL(5), "FECHADA")],
      type: "notify",
    });
    await drenarTudo();

    const d = sessao._paraTeste.descartes();
    assert.equal(d.NAO_DECIFRADA, 1, "mensagem nao aberta precisa de contador PROPRIO");
    assert.equal(d.SEM_CONTEUDO, 0, "nao pode ser confundida com recibo");
    assert.equal(mensagensEntregues().length, 0, "sem conteudo, nao ha o que gravar");
  });

  test("6. recibo continua sendo recibo", async () => {
    sessao._paraTeste.tratarMensagensNovas({
      messages: [recibo(TEL(6), "RECIBO")],
      type: "notify",
    });
    await drenarTudo();

    const d = sessao._paraTeste.descartes();
    assert.equal(d.SEM_CONTEUDO, 1);
    assert.equal(d.NAO_DECIFRADA, 0, "recibo nao pode inflar o alarme de mensagem perdida");
  });

  test("7. quando o celular reenvia o conteudo, a mensagem entra", async () => {
    // O Baileys pede o conteúdo de volta ao celular e reemite a mensagem como
    // `notify` quando ela chega. É por isso que o aviso do item 5 aparecendo
    // SOZINHO é o sinal de perda de verdade — e o par abaixo é o desfecho bom.
    sessao._paraTeste.tratarMensagensNovas({
      messages: [naoDecifrada(TEL(7), "FECHADA2")],
      type: "notify",
    });
    sessao._paraTeste.tratarMensagensNovas({
      messages: [msg(TEL(7), "FECHADA2", "cheguei pelo reenvio")],
      type: "notify",
    });
    await drenarTudo();

    const m = mensagensEntregues();
    assert.equal(m.length, 1);
    assert.equal(m[0].texto, "cheguei pelo reenvio");
  });
});

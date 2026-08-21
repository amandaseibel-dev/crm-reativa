// O QUE ENTRA NA CONVERSA E O QUE NÃO ENTRA.
//
// POR QUE ESTE ARQUIVO EXISTE — o que a Central mostrava em 20/08/2026:
//
//   378 mensagens em produção apareciam como "[outro]" — bolha vazia, sem
//   texto e sem anexo. Eram duas coisas MUITO diferentes empilhadas no mesmo
//   balde, e não havia como separá-las depois do fato:
//
//   1. MAQUINARIA DO WHATSAPP. 49 delas eram `protocolMessage` de
//      sincronização de histórico, gravadas como se o OPERADOR tivesse
//      enviado algo — rajadas de dez em três segundos dentro de conversas
//      reais. Provado cruzando o wamid `2A122F5E1AFD9F23C642` com a linha
//      "got history notification" do log do Baileys.
//
//   2. FORMATO DE GENTE QUE NÃO SABEMOS LER. Essas TÊM de continuar
//      aparecendo — some-las seria esconder do operador que o aluno mandou
//      alguma coisa. O que faltava era o NOME do formato: sem ele, dar suporte
//      a um formato novo dependia de reproduzir o caso no aparelho.
//
// A regra que estes testes protegem: descartar SÓ o que não é mensagem de
// ninguém, e nunca perder o nome do que não foi entendido.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "wa-fmt-"));
process.env.DADOS_DIR = base;
process.env.CRM_URL = "http://127.0.0.1:1";
process.env.CRM_SEGREDO = "x".repeat(64);
process.env.GATEWAY_TOKEN = "y".repeat(64);
process.env.SESSOES = "piloto";

const { criarSessao, conteudo, _usarCrmParaTeste } = await import("./sessao.js");
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

function envelope(jid, id, message, { fromMe = false } = {}) {
  return {
    key: { remoteJid: jid, id, fromMe },
    message,
    messageTimestamp: 1755600000,
    pushName: "Fulano",
  };
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

async function drenarTudo(vezes = 20) {
  for (let i = 0; i < vezes; i++) await _drenarParaTeste();
}

// ---------------------------------------------------------------------------
describe("conteudo — o que é maquinaria e o que é mensagem", () => {
  test("sincronizacao de historico e descartada, nao vira bolha", () => {
    const r = conteudo(envelope(TEL(1), "M1", {
      protocolMessage: { type: 5, historySyncNotification: { fileLength: "10" } },
    }));
    assert.equal(r.descartar, true);
    assert.deepEqual(r.formatos, ["protocolMessage"]);
  });

  test("exclusao de mensagem pelo aluno tambem sai da conversa", () => {
    // O aviso de exclusao chega como protocolMessage. Hoje ele e ignorado — a
    // mensagem original SEGUE na Central. Isso e uma divida conhecida; o que
    // este teste fixa e que a exclusao parou de virar bolha vazia por cima.
    const r = conteudo(envelope(TEL(1), "M2", {
      protocolMessage: { type: 0, key: { id: "ALVO" } },
    }));
    assert.equal(r.descartar, true);
  });

  test("chave de sessao sozinha e maquinaria", () => {
    const r = conteudo(envelope(TEL(1), "M3", {
      senderKeyDistributionMessage: { groupId: "x" },
      messageContextInfo: { deviceListMetadataVersion: 2 },
    }));
    assert.equal(r.descartar, true);
  });

  test("formato desconhecido FICA, e sai com o nome do formato", () => {
    const r = conteudo(envelope(TEL(1), "M4", {
      pollCreationMessage: { name: "enquete" },
      messageContextInfo: { deviceListMetadataVersion: 2 },
    }));
    assert.equal(r.descartar, undefined, "mensagem de gente nao pode ser descartada");
    assert.equal(r.tipo, "outro");
    assert.deepEqual(r.formatos, ["pollCreationMessage"],
      "o ruido de contexto nao pode virar o nome do formato");
  });

  test("texto e imagem continuam como sempre foram", () => {
    const t = conteudo(envelope(TEL(1), "M5", { conversation: "oi" }));
    assert.equal(t.tipo, "text");
    assert.equal(t.texto, "oi");
    assert.equal(t.formatos, undefined);

    // PRINT DE TELA cai aqui: e imageMessage e SEMPRE traz mimetype. Foi assim
    // que se provou que a mensagem "[outro]" de 20/08 nao podia ser um print.
    const i = conteudo(envelope(TEL(1), "M6", {
      imageMessage: { mimetype: "image/jpeg", caption: null },
    }));
    assert.equal(i.tipo, "image");
    assert.equal(i.mime, "image/jpeg");
  });
});

// ---------------------------------------------------------------------------
// De ponta a ponta: o que o CRM recebe. Testar so `conteudo` nao bastaria — o
// defeito de 20/08 estava em QUEM a usava, que enfileirava do mesmo jeito.
// ---------------------------------------------------------------------------
describe("tempo real — maquinaria nao chega ao CRM", () => {
  test("protocolMessage nao vira mensagem e e contado como INTERNO", async () => {
    sessao._paraTeste.tratarMensagensNovas({
      type: "notify",
      messages: [
        envelope(TEL(7), "R1", { protocolMessage: { type: 5, historySyncNotification: {} } }, { fromMe: true }),
        envelope(TEL(7), "R2", { conversation: "essa e de verdade" }),
      ],
    });
    await drenarTudo();

    const m = mensagensEntregues();
    assert.equal(m.length, 1, "so a mensagem de verdade pode passar");
    assert.equal(m[0].texto, "essa e de verdade");
    assert.equal(sessao._paraTeste.descartes().INTERNO, 1);
  });

  test("formato desconhecido chega ao CRM com o nome no payload", async () => {
    sessao._paraTeste.tratarMensagensNovas({
      type: "notify",
      messages: [envelope(TEL(8), "R3", { ptvMessage: { seconds: 4 } })],
    });
    await drenarTudo();

    const m = mensagensEntregues();
    assert.equal(m.length, 1, "mensagem de aluno nunca some");
    assert.equal(m[0].tipo, "outro");
    assert.deepEqual(m[0].payload, { formatos: ["ptvMessage"] });
  });

  test("mensagem comum nao ganha payload", async () => {
    sessao._paraTeste.tratarMensagensNovas({
      type: "notify",
      messages: [envelope(TEL(9), "R4", { conversation: "oi" })],
    });
    await drenarTudo();
    assert.equal(mensagensEntregues()[0].payload, null);
  });
});

describe("historico — mesma regra no sync inicial", () => {
  test("protocolMessage do historico nao entra na conversa", async () => {
    sessao._paraTeste.tratarHistorico({
      chats: [], contacts: [],
      messages: [
        envelope(TEL(10), "H1", { protocolMessage: { type: 3 } }, { fromMe: true }),
        envelope(TEL(10), "H2", { conversation: "historico de verdade" }),
      ],
      syncType: 2,
    });
    await drenarTudo();

    const m = mensagensEntregues();
    assert.equal(m.length, 1);
    assert.equal(m[0].texto, "historico de verdade");
    assert.equal(sessao._paraTeste.descartes().INTERNO, 1);
    assert.equal(sessao._paraTeste.descartes().aceitos, 1,
      "descartado nao pode ser contado como aceito");
  });
});

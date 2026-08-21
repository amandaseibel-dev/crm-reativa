// Resolver o JID REAL antes de enviar.
//
// O QUE ESTE ARQUIVO PROTEGE: abordagem a número novo com o 9º dígito
// (55 DD 9XXXX-XXXX) NÃO pode virar um "ENVIADO" que nunca chega. O WhatsApp
// registra muitos celulares brasileiros no JID sem o 9; o destino tem de ser
// o que o servidor devolve, não o que o operador digitou. E número fora do
// WhatsApp tem de dar ERRO, para a Edge gravar FALHOU.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// sessao.js lê a configuração ao ser importado; sem isto o import cai em /dados.
process.env.DADOS_DIR = mkdtempSync(join(tmpdir(), "wa-jid-"));
process.env.CRM_URL = "http://127.0.0.1:9";
process.env.CRM_SEGREDO = "x".repeat(64);
process.env.GATEWAY_TOKEN = "t".repeat(64);
process.env.SESSOES = "piloto";

const { resolverJid } = await import("./sessao.js");

function sockFalso(respostas, chamadas = []) {
  return {
    onWhatsApp: async (numero) => {
      chamadas.push(numero);
      return respostas[numero];
    },
  };
}

describe("resolverJid", () => {
  test("usa o JID que o WhatsApp devolve, mesmo sem o 9º dígito", async () => {
    const sock = sockFalso({
      "5551999990000": [{ jid: "555199990000@s.whatsapp.net", exists: true }],
    });
    const jid = await resolverJid(sock, "+55 (51) 99999-0000");
    assert.equal(jid, "555199990000@s.whatsapp.net");
  });

  test("número fora do WhatsApp dá ERRO, nunca um JID inventado", async () => {
    const sock = sockFalso({ "5551999990000": [] });
    await assert.rejects(() => resolverJid(sock, "5551999990000"), /nao esta no WhatsApp/);
    const sock2 = sockFalso({ "5551999990000": [{ jid: "x@s.whatsapp.net", exists: false }] });
    await assert.rejects(() => resolverJid(sock2, "5551999990000"), /nao esta no WhatsApp/);
  });

  test("o erro não expõe o telefone inteiro", async () => {
    const sock = sockFalso({ "5551999990000": undefined });
    await assert.rejects(() => resolverJid(sock, "5551999990000"), (e) => {
      assert.ok(!e.message.includes("5551999990000"));
      return true;
    });
  });

  test("cache: o mesmo número só consulta o servidor uma vez", async () => {
    const chamadas = [];
    const sock = sockFalso(
      { "5551999990000": [{ jid: "555199990000@s.whatsapp.net", exists: true }] },
      chamadas,
    );
    const cache = new Map();
    await resolverJid(sock, "5551999990000", cache);
    await resolverJid(sock, "55 51 99999-0000", cache);
    assert.equal(chamadas.length, 1);
  });

  test("falha de consulta NÃO entra no cache", async () => {
    const chamadas = [];
    const sock = sockFalso({ "5551999990000": [] }, chamadas);
    const cache = new Map();
    await assert.rejects(() => resolverJid(sock, "5551999990000", cache));
    assert.equal(cache.size, 0);
  });
});

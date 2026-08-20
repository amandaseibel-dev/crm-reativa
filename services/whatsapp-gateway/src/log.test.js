// O log NÃO pode vazar dado pessoal de aluno.
//
// POR QUE ESTE ARQUIVO EXISTE: a auditoria de LGPD de 20/08/2026 encontrou, no
// `gateway.log` de produção, 15 telefones distintos em claro e vários nomes de
// aluno. O `redact` do pino já existia, mas cobria só `texto`, `payload` e `qr`
// — nossos campos. Os telefones saíam por `msgAttrs`, que é escrito pelo
// PRÓPRIO Baileys, porque a biblioteca recebe o mesmo objeto de logger.
//
// Os valores testados aqui foram copiados do log real.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import pino from "pino";

const { _mascararPII } = await import("./log.js");

// Um logger igual ao de produção, mas escrevendo em memória para poder inspecionar.
function loggerDeTeste() {
  const linhas = [];
  const destino = new Writable({
    write(chunk, _enc, cb) { linhas.push(JSON.parse(String(chunk))); cb(); },
  });
  const l = pino(
    {
      base: { servico: "whatsapp-gateway" },
      redact: {
        paths: [
          "texto", "*.texto", "payload", "*.payload", "qr", "*.qr",
          "conversation", "*.conversation", "message", "*.message",
          "jid", "*.jid", "telefone", "*.telefone", "nome_perfil", "*.nome_perfil",
          "key.remoteJid", "key.remoteJidAlt", "key.participant", "key.participantAlt",
          "key.senderPn", "key.senderLid", "key.participantPn", "key.participantLid",
          "*.key.remoteJid", "*.key.remoteJidAlt", "*.key.participant",
          "msgAttrs.from", "msgAttrs.recipient", "msgAttrs.participant",
          "msgAttrs.sender_pn", "msgAttrs.peer_recipient_pn", "msgAttrs.sender_lid",
          "msgAttrs.notify", "msgAttrs.verified_name",
          "*.msgAttrs.from", "*.msgAttrs.sender_pn", "*.msgAttrs.notify",
          "notify", "*.notify", "pushName", "*.pushName",
          "verified_name", "*.verified_name",
        ],
        censor: _mascararPII,
      },
    },
    destino,
  );
  return { l, linhas };
}

describe("mascararPII — preserva formato, apaga identidade", () => {
  test("telefone PN vira # mantendo o sufixo e o comprimento", () => {
    assert.equal(
      _mascararPII("555195334008@s.whatsapp.net", ["msgAttrs", "sender_pn"]),
      "############@s.whatsapp.net",
    );
  });

  test("LID tambem, e da para distinguir de PN no log", () => {
    const lid = _mascararPII("173310721683688@lid", ["key", "remoteJid"]);
    assert.equal(lid, "###############@lid");
    // O diagnostico que importa continua possivel: LID x PN, 12 x 13 digitos.
    assert.ok(lid.endsWith("@lid"));
    assert.equal(lid.indexOf("@"), 15);
  });

  test("nome de pessoa some inteiro — nao ha formato que valha preservar", () => {
    assert.equal(_mascararPII("Tainah Lindner", ["msgAttrs", "notify"]), "[nome oculto]");
    assert.equal(_mascararPII("Suelen Rossi Machado", ["notify"]), "[nome oculto]");
    assert.equal(_mascararPII("Amanda", ["pushName"]), "[nome oculto]");
  });

  test("numero cru sem arroba tambem e mascarado", () => {
    assert.equal(_mascararPII("555195334008", ["telefone"]), "############");
  });

  test("qualquer outra coisa vira [oculto], nao passa por engano", () => {
    assert.equal(_mascararPII("Bom dia, quero negociar", ["texto"]), "[oculto]");
  });
});

describe("o logger de producao nao escreve PII", () => {
  // Nó real do log de 19/08/2026, com os campos que vazaram.
  const NO_REAL = {
    msgAttrs: {
      from: "172138514366591@lid",
      type: "text",
      id: "2AC9E24A96258C70092D",
      notify: "Tainah Lindner",
      sender_pn: "555191657072@s.whatsapp.net",
      peer_recipient_pn: "555195334008@s.whatsapp.net",
      verified_name: "23423656200485900",
      t: "1787171455",
    },
    retryCount: 3,
  };

  const CHAVE_REAL = {
    key: {
      remoteJid: "173310721683688@lid",
      remoteJidAlt: "555195334008@s.whatsapp.net",
      fromMe: false,
      id: "3A856A73C61EB63FBCCF",
      addressingMode: "lid",
    },
  };

  function semDigitosDePessoa(linha) {
    const bruto = JSON.stringify(linha);
    // Nenhuma sequencia de 6+ digitos que nao seja timestamp/contador conhecido.
    const suspeitos = (bruto.match(/\b\d{9,}\b/g) || [])
      .filter((n) => !/^17\d{11,}$/.test(n)); // epoch em ms do proprio pino
    return { bruto, suspeitos };
  }

  test("msgAttrs: telefone e nome nao aparecem em claro", () => {
    const { l, linhas } = loggerDeTeste();
    l.info(NO_REAL, "sent retry receipt");
    const { bruto } = semDigitosDePessoa(linhas[0]);

    assert.ok(!bruto.includes("555191657072"), "sender_pn vazou");
    assert.ok(!bruto.includes("555195334008"), "peer_recipient_pn vazou");
    assert.ok(!bruto.includes("172138514366591"), "from vazou");
    assert.ok(!bruto.includes("Tainah"), "nome vazou");
    // E o que serve para diagnostico continua la:
    assert.equal(linhas[0].msgAttrs.type, "text");
    assert.equal(linhas[0].retryCount, 3);
    assert.ok(String(linhas[0].msgAttrs.sender_pn).endsWith("@s.whatsapp.net"));
  });

  test("key: remoteJid e remoteJidAlt nao aparecem em claro", () => {
    const { l, linhas } = loggerDeTeste();
    l.error(CHAVE_REAL, "failed to decrypt message");
    const bruto = JSON.stringify(linhas[0]);

    assert.ok(!bruto.includes("173310721683688"), "remoteJid vazou");
    assert.ok(!bruto.includes("555195334008"), "remoteJidAlt vazou");
    // wamid e identificador tecnico, NAO e dado pessoal: tem que ficar.
    assert.ok(bruto.includes("3A856A73C61EB63FBCCF"), "o wamid precisa continuar no log");
    assert.equal(linhas[0].key.addressingMode, "lid");
  });

  test("conteudo de mensagem nao aparece", () => {
    const { l, linhas } = loggerDeTeste();
    l.info({ texto: "Bom dia, quero negociar minha divida", conversation: "idem" }, "mensagem");
    const bruto = JSON.stringify(linhas[0]);
    assert.ok(!bruto.includes("negociar"), "conteudo vazou");
  });

  test("segredo e token nunca sao logados por este caminho", () => {
    const { l, linhas } = loggerDeTeste();
    l.info({ qr: "2@abc,def,ghi", payload: { access_token: "eyJhbGciOi" } }, "conexao");
    const bruto = JSON.stringify(linhas[0]);
    assert.ok(!bruto.includes("eyJhbGciOi"), "token vazou");
    assert.ok(!bruto.includes("2@abc"), "QR vazou — quem tem o QR pareia um aparelho");
  });
});

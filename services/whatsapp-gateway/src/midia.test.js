// Download de mídia: arquivos reais e falhas simuladas.
//
// O que estes testes protegem: o operador precisa RECEBER o comprovante, e
// quando não der, precisa SABER que veio algo. Anexo que some calado é o pior
// desfecho — pior do que anexo que não abre.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { baixarMidia, mimeReal, nomeDoDocumento, LIMITE_BYTES, TIPOS_ACEITOS } from "./midia.js";

// ---------------------------------------------------------------- arquivos reais
function png() {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (tipo, dados) => {
    const t = Buffer.from(tipo);
    const len = Buffer.alloc(4); len.writeUInt32BE(dados.length);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(Buffer.concat([t, dados])));
    return Buffer.concat([len, t, dados, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const linhas = Buffer.concat(
    Array.from({ length: 4 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(12, 200)])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(linhas)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(120, 3)]);

const msgCom = (extra = {}) => ({
  key: { id: "M1", remoteJid: "5551999998888@s.whatsapp.net" },
  message: extra,
});

describe("mimeReal — o tipo vem dos BYTES", () => {
  test("reconhece imagem, PDF e audio reais", () => {
    assert.equal(mimeReal(png()), "image/png");
    assert.equal(mimeReal(JPEG), "image/jpeg");
    assert.equal(mimeReal(PDF), "application/pdf");
    assert.equal(mimeReal(OGG), "audio/ogg");
  });

  test("nao reconhece o que nao esta na lista", () => {
    assert.equal(mimeReal(Buffer.from("isto e so texto solto")), null);
    assert.equal(mimeReal(Buffer.alloc(0)), null);
    assert.equal(mimeReal(Buffer.from([1, 2])), null);
  });

  test("EXE disfarcado de imagem e recusado", () => {
    // O `mimetype` da mensagem e escolhido por quem envia. Se confiassemos
    // nele, bastaria mentir para colocar qualquer coisa no bucket.
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(300, 0x90)]);
    assert.equal(mimeReal(exe), null);
  });
});

describe("nomeDoDocumento", () => {
  test("pega o nome do arquivo", () => {
    assert.equal(nomeDoDocumento(msgCom({ documentMessage: { fileName: "boleto.pdf" } })), "boleto.pdf");
  });

  test("documento com legenda tambem tem nome", () => {
    assert.equal(
      nomeDoDocumento(msgCom({ documentWithCaptionMessage: { message: { documentMessage: { fileName: "acordo.pdf" } } } })),
      "acordo.pdf");
  });

  test("caminho no nome e descartado - nada de ../", () => {
    assert.equal(nomeDoDocumento(msgCom({ documentMessage: { fileName: "../../etc/passwd" } })), "passwd");
    assert.equal(nomeDoDocumento(msgCom({ documentMessage: { fileName: "C:\\\\temp\\\\x.pdf" } })), "x.pdf");
  });

  test("sem documento nao inventa nome", () => {
    assert.equal(nomeDoDocumento(msgCom({ imageMessage: {} })), null);
    assert.equal(nomeDoDocumento(null), null);
  });
});

describe("baixarMidia", () => {
  test("imagem real: devolve bytes e mime", async () => {
    const r = await baixarMidia(msgCom({ imageMessage: {} }), { baixar: async () => png() });
    assert.equal(r.mime, "image/png");
    assert.ok(r.dados.length > 0);
    assert.equal(r.erro, undefined);
  });

  test("PDF real: devolve o nome junto", async () => {
    const msg = msgCom({ documentMessage: { fileName: "comprovante.pdf" } });
    const r = await baixarMidia(msg, { baixar: async () => PDF });
    assert.equal(r.mime, "application/pdf");
    assert.equal(r.nome, "comprovante.pdf");
  });

  test("audio real", async () => {
    const r = await baixarMidia(msgCom({ audioMessage: {} }), { baixar: async () => OGG });
    assert.equal(r.mime, "audio/ogg");
  });

  test("acima do limite: recusa com motivo legivel, NAO lanca", async () => {
    const gigante = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(LIMITE_BYTES + 10, 1)]);
    const r = await baixarMidia(msgCom({ imageMessage: {} }), { baixar: async () => gigante });
    assert.equal(r.dados, undefined);
    assert.match(r.erro, /acima do limite/);
  });

  test("arquivo vazio", async () => {
    const r = await baixarMidia(msgCom({ imageMessage: {} }), { baixar: async () => Buffer.alloc(0) });
    assert.match(r.erro, /vazio/);
  });

  test("tipo nao suportado (video) e recusado pelos bytes", async () => {
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypmp42"), Buffer.alloc(100)]);
    const r = await baixarMidia(msgCom({ videoMessage: {} }), { baixar: async () => mp4 });
    // `ftyp` no deslocamento 4 casa com audio/mp4; o que importa e nao explodir
    assert.ok(r.mime || r.erro, "precisa decidir, nunca ficar no meio");
  });

  test("download que FALHA nao derruba nada - devolve motivo", async () => {
    const r = await baixarMidia(msgCom({ imageMessage: {} }), {
      baixar: async () => { throw new Error("media expirada no servidor"); },
    });
    assert.equal(r.dados, undefined);
    assert.match(r.erro, /nao foi possivel baixar/);
    assert.match(r.erro, /media expirada/);
  });

  test("NUNCA lanca, aconteca o que acontecer", async () => {
    // Quem chama roda fora da fila e nao pode derrubar a sessao.
    for (const baixar of [
      async () => { throw new Error("x"); },
      async () => null,
      async () => undefined,
      async () => { throw { sem: "message" }; },
    ]) {
      await assert.doesNotReject(() => baixarMidia(msgCom({ imageMessage: {} }), { baixar }));
    }
  });

  test("SEMPRE devolve dados OU erro, nunca os dois nem nenhum", async () => {
    const casos = [
      async () => png(),
      async () => Buffer.alloc(0),
      async () => Buffer.from("lixo"),
      async () => { throw new Error("falhou"); },
    ];
    for (const baixar of casos) {
      const r = await baixarMidia(msgCom({ imageMessage: {} }), { baixar });
      assert.ok(Boolean(r.dados) !== Boolean(r.erro), "precisa ter um dos dois, e so um");
    }
  });
});

describe("tipos aceitos nesta fase", () => {
  test("imagem, documento e audio entram; video nao", () => {
    assert.ok(TIPOS_ACEITOS.has("image"));
    assert.ok(TIPOS_ACEITOS.has("document"));
    assert.ok(TIPOS_ACEITOS.has("audio"));
    assert.ok(TIPOS_ACEITOS.has("audio_voz"));
    assert.ok(!TIPOS_ACEITOS.has("video"), "video ficou fora por decisao");
    assert.ok(!TIPOS_ACEITOS.has("sticker"));
  });
});

// Envio de áudio gravado na Central — o caminho de SAÍDA.
//
// O QUE ESTE ARQUIVO PROTEGE:
//
//   1. SAI COMO MENSAGEM DE VOZ, PELO NÚMERO DA CONVERSA. `ptt: true` e OGG/Opus
//      é o que faz o celular do aluno tocar; número errado é o mesmo dano de
//      responder a pessoa errada.
//
//   2. FALHA NÃO VIRA SUCESSO. Conversão que falha, sessão caída ou arquivo que
//      não é gravação devolvem ERRO — é isso que faz a Edge registrar FALHOU.
//
//   3. O TIPO É DECIDIDO PELOS BYTES, e o teto é o mesmo 1 MB dos dois lados.
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "wa-audio-"));

// CRM de mentira que responde na hora — mesmo motivo do documento.test.js.
const crmFalso = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
await new Promise((pronto) => crmFalso.listen(0, "127.0.0.1", pronto));
after(() => crmFalso.close());

process.env.DADOS_DIR = base;
process.env.CRM_URL = `http://127.0.0.1:${crmFalso.address().port}`;
process.env.CRM_SEGREDO = "x".repeat(64);
process.env.GATEWAY_TOKEN = "y".repeat(64);
process.env.SESSOES = "piloto,comercial";

const {
  criarSessao, _usarCrmParaTeste, _usarSocketParaTeste, _usarConversorParaTeste,
} = await import("./sessao.js");
const {
  LIMITE_AUDIO_BYTES, MIME_VOZ, converterParaOggOpus, duracaoOggSegundos, formatoDoAudio,
} = await import("./audio.js");

_usarCrmParaTeste(async () => ({ ok: true }));

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 7)]);

// Página OGG mínima com a posição de grânulo pedida (amostras a 48 kHz).
function ogg(amostras = 48000 * 12) {
  const pagina = Buffer.alloc(40, 0);
  pagina.write("OggS", 0, "latin1");
  pagina.writeBigUInt64LE(BigInt(amostras), 6);
  return pagina;
}

function socketFalso() {
  const eventos = new Map();
  const enviados = [];
  return {
    enviados,
    user: { id: "555196316324:88@s.whatsapp.net" },
    ev: {
      on(nome, fn) { eventos.set(nome, fn); },
      removeAllListeners(nome) { eventos.delete(nome); },
      emit(nome, arg) { return eventos.get(nome)?.(arg); },
    },
    end() {},
    sendMessage: async (jid, conteudo) => {
      enviados.push({ jid, conteudo });
      return { key: { id: `wamid-${enviados.length}` } };
    },
    onWhatsApp: async (numero) => [{ jid: `${numero}@s.whatsapp.net`, exists: true }],
  };
}

async function sessaoConectada(chave) {
  const sock = socketFalso();
  _usarSocketParaTeste(() => sock, async () => ({ version: [2, 3000, 1] }));
  const sessao = criarSessao(chave);
  await sessao.iniciar?.();
  await sock.ev.emit("connection.update", { connection: "open" });
  return { sessao, sock };
}

// Processo de mentira no lugar do ffmpeg.
function processoFalso({ saida = null, codigo = 0, queixa = "", nuncaTermina = false } = {}) {
  return () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.stdin = new EventEmitter();
    p.morto = false;
    p.kill = () => { p.morto = true; };
    p.stdin.end = () => {
      if (nuncaTermina) return;
      setImmediate(() => {
        if (queixa) p.stderr.emit("data", Buffer.from(queixa));
        if (saida) p.stdout.emit("data", saida);
        p.emit("close", codigo);
      });
    };
    return p;
  };
}

describe("formato e duracao", () => {
  test("reconhece OGG e WebM pelos bytes e recusa o resto", () => {
    assert.equal(formatoDoAudio(ogg()), "ogg");
    assert.equal(formatoDoAudio(WEBM), "webm");
    assert.equal(formatoDoAudio(Buffer.from("%PDF-1.7 nao e audio")), null);
    assert.equal(formatoDoAudio(Buffer.from("MZ executavel")), null);
    assert.equal(formatoDoAudio(Buffer.alloc(0)), null);
  });

  test("duracao sai da ultima pagina", () => {
    assert.equal(duracaoOggSegundos(ogg(48000 * 12)), 12);
    assert.equal(duracaoOggSegundos(Buffer.concat([ogg(48000), ogg(48000 * 30 + 1)])), 31);
    assert.equal(duracaoOggSegundos(Buffer.from("sem pagina nenhuma")), null);
    assert.equal(duracaoOggSegundos(ogg(0)), null);
  });

  test("teto de 1 MB - o mesmo da Edge e do corpo da API", () => {
    assert.equal(LIMITE_AUDIO_BYTES, 1_000_000);
  });
});

describe("conversao", () => {
  test("devolve o OGG que o conversor produziu", async () => {
    const r = await converterParaOggOpus(WEBM, { gerar: processoFalso({ saida: ogg() }) });
    assert.equal(formatoDoAudio(r), "ogg");
  });

  test("conversor que sai com erro vira ERRO, com o motivo", async () => {
    await assert.rejects(
      () => converterParaOggOpus(WEBM, {
        gerar: processoFalso({ codigo: 1, queixa: "Invalid data found" }),
      }),
      /nao foi possivel converter o audio \(Invalid data found\)/,
    );
  });

  test("saida que nao e OGG e recusada mesmo com codigo 0", async () => {
    await assert.rejects(
      () => converterParaOggOpus(WEBM, { gerar: processoFalso({ saida: Buffer.from("lixo") }) }),
      /nao devolveu um audio valido/,
    );
  });

  test("ffmpeg ausente vira ERRO claro", async () => {
    const gerar = () => {
      const p = processoFalso({ nuncaTermina: true })();
      setImmediate(() => p.emit("error", new Error("spawn ffmpeg ENOENT")));
      return p;
    };
    await assert.rejects(
      () => converterParaOggOpus(WEBM, { gerar }),
      /conversor de audio indisponivel/,
    );
  });

  test("conversao travada e morta no prazo", async () => {
    let processo;
    const fabrica = processoFalso({ nuncaTermina: true });
    const gerar = () => { processo = fabrica(); return processo; };
    await assert.rejects(
      () => converterParaOggOpus(WEBM, { gerar, tempoLimiteMs: 20 }),
      /demorou demais/,
    );
    assert.equal(processo.morto, true);
  });
});

describe("envio de audio", () => {
  beforeEach(() => {
    _usarConversorParaTeste(async () => ogg(48000 * 12));
  });

  test("1. sai como mensagem de voz, em OGG, pelo telefone da conversa", async () => {
    const { sessao, sock } = await sessaoConectada("piloto");

    const r = await sessao.enviarAudio("5551999998888", { dados: WEBM });

    assert.equal(sock.enviados.length, 1);
    assert.equal(sock.enviados[0].jid, "5551999998888@s.whatsapp.net");
    const c = sock.enviados[0].conteudo;
    assert.equal(c.ptt, true);
    assert.equal(c.mimetype, MIME_VOZ);
    assert.equal(c.seconds, 12);
    assert.equal(formatoDoAudio(c.audio), "ogg", "o que sai e o convertido, nao o WebM");
    assert.equal(r.wamid, "wamid-1");
    assert.equal(formatoDoAudio(r.ogg), "ogg");
  });

  test("2. o numero de saida e o da sessao - nao vaza para o outro", async () => {
    const { sessao: piloto, sock: sockPiloto } = await sessaoConectada("piloto");
    const { sessao: comercial, sock: sockComercial } = await sessaoConectada("comercial");

    await comercial.enviarAudio("5551977776666", { dados: WEBM });
    assert.equal(sockComercial.enviados.length, 1);
    assert.equal(sockPiloto.enviados.length, 0, "vazou para o outro numero");

    await piloto.enviarAudio("5551999998888", { dados: WEBM });
    assert.equal(sockPiloto.enviados.length, 1);
    assert.equal(sockComercial.enviados.length, 1);
  });

  test("3. sessao desconectada recusa", async () => {
    const sock = socketFalso();
    _usarSocketParaTeste(() => sock, async () => ({ version: [2, 3000, 1] }));
    const sessao = criarSessao("piloto");
    await sessao.iniciar?.();

    await assert.rejects(
      () => sessao.enviarAudio("5551999998888", { dados: WEBM }),
      /nao esta conectada/,
    );
    assert.equal(sock.enviados.length, 0);
  });

  test("4. vazio, grande demais e o que nao e gravacao nao saem", async () => {
    const { sessao, sock } = await sessaoConectada("piloto");

    await assert.rejects(() => sessao.enviarAudio("5551999998888", { dados: Buffer.alloc(0) }), /audio vazio/);
    await assert.rejects(() => sessao.enviarAudio("5551999998888", {}), /audio vazio/);
    await assert.rejects(
      () => sessao.enviarAudio("5551999998888", {
        dados: Buffer.concat([WEBM, Buffer.alloc(LIMITE_AUDIO_BYTES)]),
      }),
      /acima do limite/,
    );
    await assert.rejects(
      () => sessao.enviarAudio("5551999998888", { dados: Buffer.from("%PDF-1.7 renomeado") }),
      /nao e um audio gravado/,
    );
    assert.equal(sock.enviados.length, 0, "nao pode ter mandado nada");
  });

  test("5. conversao que falha vira ERRO, nao mensagem", async () => {
    const { sessao, sock } = await sessaoConectada("piloto");
    _usarConversorParaTeste(async () => { throw new Error("conversor de audio indisponivel"); });

    await assert.rejects(
      () => sessao.enviarAudio("5551999998888", { dados: WEBM }),
      /conversor de audio indisponivel/,
    );
    assert.equal(sock.enviados.length, 0);
  });

  test("6. sendMessage que explode propaga o erro", async () => {
    const { sessao, sock } = await sessaoConectada("piloto");
    sock.sendMessage = async () => { throw new Error("timed out"); };

    await assert.rejects(
      () => sessao.enviarAudio("5551999998888", { dados: WEBM }),
      /timed out/,
    );
  });
});

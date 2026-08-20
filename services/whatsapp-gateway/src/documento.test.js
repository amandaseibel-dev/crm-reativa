// Envio de documento (PDF) — o caminho de SAÍDA.
//
// O QUE ESTE ARQUIVO PROTEGE, na ordem em que importa:
//
//   1. O DOCUMENTO SAI PELO NÚMERO DA CONVERSA. Responder um aluno pelo número
//      errado é o mesmo dano de responder a pessoa errada: ele recebe um
//      arquivo com dados dele vindo de um número que nunca procurou.
//
//   2. FALHA NÃO VIRA SUCESSO. Quem chama precisa receber ERRO — é isso que faz
//      a Edge registrar a mensagem como FALHOU em vez de ENVIADO. Um envio que
//      falha e responde `ok` some do radar e ninguém reenvia.
//
//   3. O QUE CHEGA É CONFERIDO ANTES DE VIRAR MENSAGEM. Este é o último ponto
//      antes do telefone do aluno: arquivo vazio, grande demais ou que não é
//      PDF não passa daqui, mesmo tendo passado pela Edge.
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "wa-documento-"));

// CRM DE MENTIRA, EM VEZ DE UM ENDERECO MORTO.
//
// Apontar CRM_URL para uma porta fechada faz cada `criarSessao` gastar ~14s
// batendo em timeout e backoff antes de desistir da credencial -- 9 testes
// viravam 2 minutos. Um servidor que responde na hora tira a rede do caminho
// sem mudar nada do codigo de producao.
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
  criarSessao, LIMITE_DOCUMENTO_BYTES,
  _usarCrmParaTeste, _usarSocketParaTeste, _usarFetchParaTeste,
} = await import("./sessao.js");

_usarCrmParaTeste(async () => ({ ok: true }));

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);

// Resposta de download de mentira, no formato que `fetch` devolve.
function baixando(conteudo, ok = true, status = 200) {
  return async () => ({
    ok,
    status,
    arrayBuffer: async () => conteudo.buffer.slice(
      conteudo.byteOffset, conteudo.byteOffset + conteudo.byteLength,
    ),
  });
}

// Socket de mentira que anota TUDO que foi mandado enviar. É por ele que se
// prova o número de saída e o conteúdo — não pelo retorno da função.
function socketFalso() {
  const eventos = new Map();
  const enviados = [];
  const s = {
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
  };
  return s;
}

// Leva a sessão até CONECTADO sem rede: cria o socket falso e dispara o evento
// de conexão aberta, que é o que o código real espera.
async function sessaoConectada(chave) {
  const sock = socketFalso();
  _usarSocketParaTeste(() => sock, async () => ({ version: [2, 3000, 1] }));
  const sessao = criarSessao(chave);
  await sessao.iniciar?.();
  await sock.ev.emit("connection.update", { connection: "open" });
  return { sessao, sock };
}

describe("envio de documento", () => {
  beforeEach(() => {
    _usarFetchParaTeste(baixando(PDF));
  });

  test("6. sai pelo canal da conversa, com nome e mime de documento", async () => {
    const { sessao, sock } = await sessaoConectada("piloto");

    const r = await sessao.enviarDocumento("5551999998888", {
      url: "https://exemplo/assinada",
      nome: "acordo.pdf",
      mime: "application/pdf",
    });

    assert.equal(sock.enviados.length, 1);
    // o destino é o telefone da conversa, normalizado para jid
    assert.equal(sock.enviados[0].jid, "5551999998888@s.whatsapp.net");
    // e o conteúdo é documento, não texto
    assert.equal(sock.enviados[0].conteudo.fileName, "acordo.pdf");
    assert.equal(sock.enviados[0].conteudo.mimetype, "application/pdf");
    assert.ok(Buffer.isBuffer(sock.enviados[0].conteudo.document));
    assert.equal(sock.enviados[0].conteudo.text, undefined);
    assert.equal(r.wamid, "wamid-1");
  });

  test("6b. cada sessao envia pelo SEU socket - nunca pelo do outro numero", async () => {
    const { sessao: piloto, sock: sockPiloto } = await sessaoConectada("piloto");
    const { sessao: comercial, sock: sockComercial } = await sessaoConectada("comercial");

    await piloto.enviarDocumento("5551999998888", { url: "u", nome: "a.pdf" });

    assert.equal(sockPiloto.enviados.length, 1);
    assert.equal(sockComercial.enviados.length, 0, "vazou para o outro numero");
    // e o inverso
    await comercial.enviarDocumento("5551977776666", { url: "u", nome: "b.pdf" });
    assert.equal(sockPiloto.enviados.length, 1);
    assert.equal(sockComercial.enviados.length, 1);
  });

  test("5. sessao desconectada recusa - nao enfileira nem finge que enviou", async () => {
    const sock = socketFalso();
    _usarSocketParaTeste(() => sock, async () => ({ version: [2, 3000, 1] }));
    const sessao = criarSessao("piloto");
    await sessao.iniciar?.();
    // sem `connection.update` -> nunca ficou CONECTADO

    await assert.rejects(
      () => sessao.enviarDocumento("5551999998888", { url: "u", nome: "a.pdf" }),
      /nao esta conectada/,
    );
    assert.equal(sock.enviados.length, 0);
  });

  test("5b. download que falha vira ERRO, nao mensagem", async () => {
    const { sessao, sock } = await sessaoConectada("piloto");
    _usarFetchParaTeste(baixando(PDF, false, 403));

    await assert.rejects(
      () => sessao.enviarDocumento("5551999998888", { url: "u", nome: "a.pdf" }),
      /HTTP 403/,
    );
    assert.equal(sock.enviados.length, 0, "nao pode ter mandado nada");
  });

  test("5c. sendMessage que explode propaga o erro", async () => {
    const { sessao, sock } = await sessaoConectada("piloto");
    sock.sendMessage = async () => { throw new Error("timed out"); };

    await assert.rejects(
      () => sessao.enviarDocumento("5551999998888", { url: "u", nome: "a.pdf" }),
      /timed out/,
    );
  });

  test("3. o que nao e PDF nao vira mensagem, mesmo chegando ate aqui", async () => {
    const { sessao, sock } = await sessaoConectada("piloto");
    _usarFetchParaTeste(baixando(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])));

    await assert.rejects(
      () => sessao.enviarDocumento("5551999998888", { url: "u", nome: "a.pdf" }),
      /nao e um PDF/,
    );
    assert.equal(sock.enviados.length, 0);
  });

  test("4. acima do limite nao sai - e o limite bate com o da Edge", async () => {
    const { sessao, sock } = await sessaoConectada("piloto");
    const grande = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(LIMITE_DOCUMENTO_BYTES, 0x20),
    ]);
    _usarFetchParaTeste(baixando(grande));

    await assert.rejects(
      () => sessao.enviarDocumento("5551999998888", { url: "u", nome: "a.pdf" }),
      /acima do limite/,
    );
    assert.equal(sock.enviados.length, 0);
    // O número está repetido em dois processos (aqui e no validador da Edge).
    // Se divergir, um lado aceita o que o outro recusa e o operador vê um erro
    // que não faz sentido.
    assert.equal(LIMITE_DOCUMENTO_BYTES, 16 * 1024 * 1024);
  });

  test("4b. documento vazio nao sai", async () => {
    const { sessao, sock } = await sessaoConectada("piloto");
    _usarFetchParaTeste(baixando(Buffer.alloc(0)));

    await assert.rejects(
      () => sessao.enviarDocumento("5551999998888", { url: "u", nome: "a.pdf" }),
      /vazio/,
    );
    assert.equal(sock.enviados.length, 0);
  });

  test("sem url nao tenta baixar nada", async () => {
    const { sessao } = await sessaoConectada("piloto");
    await assert.rejects(
      () => sessao.enviarDocumento("5551999998888", { nome: "a.pdf" }),
      /sem url/,
    );
  });
});

// O que acontece com a CREDENCIAL quando a conexão cai.
//
// POR QUE ESTE ARQUIVO EXISTE: em 19/08/2026 o número da empresa ficou 33
// minutos fora do ar pedindo QR, e ninguém tinha desconectado nada. O WhatsApp
// mandou um `stream:error` sem o atributo `code`; o Baileys traduz isso para o
// valor de enchimento `badSession` (500); o gateway tratava 500 como credencial
// morta e apagava do disco E do Postgres. A credencial estava perfeita.
//
// O prejuízo não é o downtime: é que reparear gasta a ÚNICA sincronização
// inicial de histórico daquele número. Apagar credencial é irreversível, então
// cada código de queda tem teste próprio aqui.
//
// Os testes 1–3 e 6 exercitam a decisão pura. Os testes 4 e 5 exercitam a queda
// INTEIRA, pelo mesmo caminho que o evento do Baileys percorre, com um duplo de
// credencial que registra se `apagar()` foi chamado.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisconnectReason, getErrorCodeFromStreamError } from "baileys";

const base = mkdtempSync(join(tmpdir(), "wa-queda-"));
process.env.DADOS_DIR = base;
process.env.CRM_URL = "http://127.0.0.1:1";
process.env.CRM_SEGREDO = "x".repeat(64);
process.env.GATEWAY_TOKEN = "y".repeat(64);
process.env.SESSOES = "piloto";

const { criarSessao, politicaDeQueda, _usarCrmParaTeste } = await import("./sessao.js");

// O CRM não pode ser tocado por estes testes: aqui só interessa a credencial.
_usarCrmParaTeste(async () => ({ ok: true }));

// ---------------------------------------------------------------------------
// Duplo de credencial: só precisa dizer se foi apagada.
// ---------------------------------------------------------------------------
function authFalso() {
  return {
    apagada: false,
    async apagar() { this.apagada = true; },
    async descarregar() {},
    salvarCredenciais() {},
    state: { creds: {}, keys: {} },
  };
}

// Monta uma sessão com credencial e reconexão sob controle do teste.
function sessaoDeTeste() {
  const sessao = criarSessao({ chave: "piloto" });
  const auth = authFalso();
  const reconexoes = [];
  sessao._paraTeste.usarAuth(auth);
  sessao._paraTeste.usarReconexao((ms) => reconexoes.push(ms));
  return { sessao, auth, reconexoes };
}

// ---------------------------------------------------------------------------
// 1. stream:error sem `code` → o Baileys inventa 500, e isso não pode apagar
// ---------------------------------------------------------------------------
describe("stream:error sem code", () => {
  // Este é o nó EXATO que derrubou a sessão em 19/08/2026, copiado do log.
  const NO_REAL = {
    tag: "stream:error",
    attrs: {},
    content: [{ tag: "ack", attrs: { class: "message", type: "text", id: "2AE1F183DA9C1B4DA305" } }],
  };

  test("o Baileys converte para 500 (badSession) por falta de codigo", () => {
    const { statusCode } = getErrorCodeFromStreamError(NO_REAL);
    // Se esta asserção quebrar numa atualização do Baileys, ótimo: significa
    // que o mapeamento mudou e a política precisa ser revista de propósito.
    assert.equal(statusCode, DisconnectReason.badSession);
    assert.equal(statusCode, 500);
  });

  test("e esse 500 NAO apaga a credencial", () => {
    const { statusCode } = getErrorCodeFromStreamError(NO_REAL);
    assert.notEqual(politicaDeQueda(statusCode).acao, "APAGAR_E_PAREAR");
  });

  test("um stream:error COM code 401 continua sendo apagamento", () => {
    const comCodigo = {
      tag: "stream:error",
      attrs: { code: "401" },
      content: [{ tag: "conflict", attrs: { type: "device_removed" } }],
    };
    const { statusCode } = getErrorCodeFromStreamError(comCodigo);
    assert.equal(statusCode, DisconnectReason.loggedOut);
    assert.equal(politicaDeQueda(statusCode).acao, "APAGAR_E_PAREAR");
  });
});

// ---------------------------------------------------------------------------
// 2 e 3. A decisão por código
// ---------------------------------------------------------------------------
describe("politica por codigo de queda", () => {
  test("badSession 500 reconecta preservando a credencial", () => {
    assert.equal(politicaDeQueda(DisconnectReason.badSession).acao, "RECONECTAR");
  });

  test("loggedOut 401 apaga a credencial e pede QR", () => {
    const p = politicaDeQueda(DisconnectReason.loggedOut);
    assert.equal(p.acao, "APAGAR_E_PAREAR");
    assert.match(p.texto, /QR/);
  });

  test("multideviceMismatch 411 apaga: o WhatsApp mandou o codigo explicito", () => {
    // Ao contrário do 500, o 411 nunca é chute do Baileys — só aparece quando
    // vem `code="411"` do outro lado, e a credencial é mesmo inutilizável.
    assert.equal(politicaDeQueda(DisconnectReason.multideviceMismatch).acao, "APAGAR_E_PAREAR");
  });

  test("connectionReplaced 440 para, mas nao apaga", () => {
    assert.equal(politicaDeQueda(DisconnectReason.connectionReplaced).acao, "PARAR");
  });
});

// ---------------------------------------------------------------------------
// 6. Nenhuma queda comum pode limpar credencial
// ---------------------------------------------------------------------------
describe("quedas comuns preservam a credencial", () => {
  const comuns = [
    ["connectionLost", DisconnectReason.connectionLost],
    ["connectionClosed", DisconnectReason.connectionClosed],
    ["restartRequired", DisconnectReason.restartRequired],
    ["timedOut", DisconnectReason.timedOut],
    ["unavailableService", DisconnectReason.unavailableService],
    ["badSession", DisconnectReason.badSession],
  ];

  for (const [nome, codigo] of comuns) {
    test(`${nome} (${codigo}) nao apaga`, () => {
      assert.notEqual(politicaDeQueda(codigo).acao, "APAGAR_E_PAREAR");
    });
  }

  test("restartRequired reconecta rapido: o historico vem na conexao seguinte", () => {
    const p = politicaDeQueda(DisconnectReason.restartRequired);
    assert.equal(p.acao, "REINICIAR");
    assert.ok(p.atrasoMs <= 1000, "esperar demais aqui custa o historico do pareamento");
  });

  test("codigo desconhecido tambem preserva", () => {
    assert.equal(politicaDeQueda(undefined).acao, "RECONECTAR");
    assert.equal(politicaDeQueda(999).acao, "RECONECTAR");
  });
});

// ---------------------------------------------------------------------------
// 4 e 5. Sequências, pela queda de verdade
// ---------------------------------------------------------------------------
describe("queda de ponta a ponta", () => {
  let ctx;
  beforeEach(() => { ctx = sessaoDeTeste(); });

  test("2. badSession 500 reconecta e mantem o auth state", async () => {
    const { sessao, auth, reconexoes } = ctx;
    await sessao._paraTeste.tratarQueda(DisconnectReason.badSession);

    assert.equal(auth.apagada, false, "500 nao pode apagar credencial");
    assert.equal(sessao._paraTeste.auth(), auth, "a sessao tem que continuar com o mesmo auth");
    assert.equal(reconexoes.length, 1, "precisa TENTAR voltar, nao desistir");
    assert.equal(sessao.estado().status, "DESCONECTADO");
  });

  test("3. loggedOut 401 apaga e pede QR", async () => {
    const { sessao, auth, reconexoes } = ctx;
    await sessao._paraTeste.tratarQueda(DisconnectReason.loggedOut);

    assert.equal(auth.apagada, true, "401 e invalidacao inequivoca: tem que apagar");
    assert.equal(sessao._paraTeste.auth(), null, "auth precisa sair da memoria tambem");
    assert.equal(sessao.estado().status, "PAREAMENTO_NECESSARIO");
    assert.equal(reconexoes.length, 1);
  });

  test("4. 500 seguido de reconexao valida: mesma credencial, sem QR", async () => {
    const { sessao, auth } = ctx;

    // Três quedas 500 seguidas — o cenário real, em que o stream:error sem
    // código se repete enquanto a rede oscila.
    await sessao._paraTeste.tratarQueda(DisconnectReason.badSession);
    await sessao._paraTeste.tratarQueda(DisconnectReason.badSession);
    await sessao._paraTeste.tratarQueda(DisconnectReason.badSession);
    assert.equal(auth.apagada, false);

    // A reconexão dá certo: é o `connection: "open"` do Baileys.
    await sessao._paraTeste.conexaoAberta({ jid: "555196316324" });

    assert.equal(auth.apagada, false, "a credencial atravessou o incidente inteira");
    assert.equal(sessao._paraTeste.auth(), auth);
    assert.equal(sessao.estado().status, "CONECTADO");
    assert.equal(sessao.estado().temQr, false, "voltar do 500 nao pode exigir QR");
  });

  test("5. se depois do 500 vier um 401 real, ai sim apaga", async () => {
    const { sessao, auth } = ctx;

    await sessao._paraTeste.tratarQueda(DisconnectReason.badSession);
    assert.equal(auth.apagada, false, "o 500 sozinho nao decide nada");

    // A credencial estava mesmo morta: a tentativa seguinte volta com 401
    // explícito. É assim que o erro se corrige sozinho, sem apagar por engano.
    await sessao._paraTeste.tratarQueda(DisconnectReason.loggedOut);

    assert.equal(auth.apagada, true);
    assert.equal(sessao.estado().status, "PAREAMENTO_NECESSARIO");
  });
});

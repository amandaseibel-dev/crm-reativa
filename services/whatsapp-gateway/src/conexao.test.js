// Ciclo de vida da conexão: um socket por vez.
//
// POR QUE ESTE ARQUIVO EXISTE: em 20/08/2026 o gateway abriu DUAS conexões
// simultâneas e uma derrubou a outra. No log saíram "connected to WA" e
// "logging in..." em duplicata, seguidos de `440 connectionReplaced` — sete
// vezes em oito horas. Não era outro aparelho: era o serviço brigando consigo
// mesmo.
//
// Duas causas, as duas corrigidas aqui:
//
//   1. `conectar()` fazia `sock = makeWASocket(...)` sem encerrar o socket
//      anterior. A referência trocava; o socket velho continuava vivo e
//      falando com o WhatsApp.
//
//   2. A trava `reconectando` era liberada na PRIMEIRA linha de `conectar()`,
//      antes de dois `await` de rede (`usarAuthStatePostgres` e
//      `fetchLatestBaileysVersion`). Nessa janela `agendarReconexao` se
//      considerava livre e disparava outra conexão.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "wa-conexao-"));
process.env.DADOS_DIR = base;
process.env.CRM_URL = "http://127.0.0.1:1";
process.env.CRM_SEGREDO = "x".repeat(64);
process.env.GATEWAY_TOKEN = "y".repeat(64);
process.env.SESSOES = "piloto";

const { criarSessao, encerrarSocket, _usarCrmParaTeste, _usarSocketParaTeste } =
  await import("./sessao.js");

_usarCrmParaTeste(async () => ({ ok: true }));

// ---------------------------------------------------------------------------
// Socket de mentira que registra o que aconteceu com ele.
// ---------------------------------------------------------------------------
function socketFalso(id) {
  const eventos = new Map();
  return {
    id,
    encerrado: false,
    ordem: [],
    user: { id: "555196316324:88@s.whatsapp.net" },
    ev: {
      on(nome, fn) { eventos.set(nome, fn); },
      removeAllListeners(nome) {
        eventos.delete(nome);
        this._dono.ordem.push(`remove:${nome}`);
      },
      emit(nome, arg) { return eventos.get(nome)?.(arg); },
      get tamanho() { return eventos.size; },
    },
    end() { this.ordem.push("end"); this.encerrado = true; },
  };
}

function comDono(s) { s.ev._dono = s; return s; }

let criados;
let versaoDemora;

function instalarFabrica() {
  criados = [];
  versaoDemora = 0;
  _usarSocketParaTeste(
    () => { const s = comDono(socketFalso(criados.length + 1)); criados.push(s); return s; },
    async () => {
      if (versaoDemora) await new Promise((r) => setTimeout(r, versaoDemora));
      return { version: [2, 3000, 1] };
    },
  );
}

beforeEach(instalarFabrica);

// ---------------------------------------------------------------------------
describe("encerrarSocket — desliga sem disparar nada", () => {
  test("remove os manipuladores ANTES de encerrar", () => {
    const s = comDono(socketFalso(1));
    s.ev.on("connection.update", () => {});
    s.ev.on("messages.upsert", () => {});

    encerrarSocket(s);

    const posRemove = s.ordem.findIndex((x) => x.startsWith("remove:"));
    const posEnd = s.ordem.indexOf("end");
    assert.ok(posRemove >= 0, "precisa remover manipuladores");
    assert.ok(posEnd >= 0, "precisa encerrar");
    // A ORDEM e o ponto: encerrar primeiro faria o socket morrendo emitir
    // `close`, o manipulador leria como queda e agendaria outra reconexao.
    assert.ok(posRemove < posEnd, "remover manipuladores tem que vir ANTES do end");
  });

  test("desliga connection.update — a origem da cascata", () => {
    const s = comDono(socketFalso(1));
    let quedas = 0;
    s.ev.on("connection.update", () => { quedas++; });

    encerrarSocket(s);
    s.ev.emit("connection.update", { connection: "close" });

    assert.equal(quedas, 0, "socket encerrado nao pode mais avisar queda");
  });

  test("socket nulo nao quebra", () => {
    assert.equal(encerrarSocket(null), false);
    assert.equal(encerrarSocket(undefined), false);
  });

  test("socket que ja morreu nao propaga excecao", () => {
    const ruim = { ev: { removeAllListeners() { throw new Error("morto"); } },
                   end() { throw new Error("morto"); } };
    assert.doesNotThrow(() => encerrarSocket(ruim));
  });
});

// ---------------------------------------------------------------------------
describe("conectar — um socket por vez", () => {
  test("duas chamadas concorrentes criam UM socket, nao dois", async () => {
    versaoDemora = 30; // segura dentro do await, onde a corrida acontecia
    const s = criarSessao({ chave: "piloto" });

    await Promise.all([s.iniciar(), s.iniciar(), s.iniciar()]);

    assert.equal(criados.length, 1, "era exatamente isto que gerava o 440");
  });

  test("reconectar encerra o socket anterior antes de criar o novo", async () => {
    const s = criarSessao({ chave: "piloto" });
    await s.iniciar();
    assert.equal(criados.length, 1);
    const primeiro = criados[0];

    await s.reconectar();

    assert.equal(criados.length, 2, "precisa criar o novo");
    assert.equal(primeiro.encerrado, true, "o antigo nao pode ficar vivo falando com o WhatsApp");
  });

  test("o socket antigo nao fica com manipulador vivo", async () => {
    const s = criarSessao({ chave: "piloto" });
    await s.iniciar();
    const primeiro = criados[0];
    assert.ok(primeiro.ev.tamanho > 0, "o primeiro tinha manipuladores");

    await s.reconectar();

    assert.equal(primeiro.ev.tamanho, 0, "todos os manipuladores do antigo saíram");
  });

  test("nao sobra socket orfao depois de varias reconexoes", async () => {
    const s = criarSessao({ chave: "piloto" });
    await s.iniciar();
    await s.reconectar();
    await s.reconectar();
    await s.reconectar();

    assert.equal(criados.length, 4);
    const vivos = criados.filter((x) => !x.encerrado);
    assert.equal(vivos.length, 1, "so o ultimo pode estar vivo");
    assert.equal(vivos[0], criados[3]);
  });

  test("`parando` continua impedindo conexao nova", async () => {
    const s = criarSessao({ chave: "piloto" });
    await s.iniciar();
    await s.encerrar();
    const antes = criados.length;

    await s.iniciar();

    assert.equal(criados.length, antes, "sessao encerrada nao reconecta");
  });
});

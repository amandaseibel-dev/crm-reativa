// Testes da fila com quarentena. Rodar: npm test
//
// O CRM é substituído por um duplo em memória, para reproduzir exatamente o
// incidente: um item que o CRM recusa PARA SEMPRE, com mensagens reais atrás.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "wa-fila-"));
process.env.DADOS_DIR = base;
process.env.CRM_URL = "http://127.0.0.1:1";
process.env.CRM_SEGREDO = "x".repeat(64);
process.env.GATEWAY_TOKEN = "y".repeat(64);
process.env.SESSOES = "teste";

const chamadas = [];
let responder = async () => ({ ok: true });

const { enfileirar, tamanhoDaFila, tamanhoDaQuarentena, _drenarParaTeste, _usarEntregadorParaTeste } =
  await import("./outbox.js");

_usarEntregadorParaTeste(async (acao, dados) => {
  chamadas.push({ acao, dados });
  return responder(acao, dados);
});

const fila = () => readdirSync(join(base, "fila")).filter((n) => n.endsWith(".json"));
const quarentena = () =>
  readdirSync(join(base, "quarentena")).filter((n) => n.endsWith(".json") && !n.endsWith(".motivo.json"));

beforeEach(() => {
  chamadas.length = 0;
  responder = async () => ({ ok: true });
  for (const d of ["fila", "quarentena"]) {
    for (const f of readdirSync(join(base, d))) rmSync(join(base, d, f));
  }
});

describe("fila com quarentena", () => {
  test("caminho normal: entrega e apaga", async () => {
    enfileirar("mensagem", { telefone: "5551999998888" });
    await _drenarParaTeste();
    assert.equal(chamadas.length, 1);
    assert.equal(tamanhoDaFila(), 0);
    assert.equal(tamanhoDaQuarentena(), 0);
  });

  test("item impossivel NAO bloqueia os que vem depois", async () => {
    // Este e o incidente: telefone "0" recusado para sempre, com mensagem real
    // e o fechamento do sync atras dele.
    enfileirar("mensagem", { telefone: "0", origem: "SYNC_INICIAL" });
    enfileirar("mensagem", { telefone: "5551999998888", origem: "TEMPO_REAL" });
    enfileirar("sync.contabilizar", { conversas: 247, mensagens: 5000 });
    enfileirar("sync.concluir", {});

    responder = async (_acao, dados) => {
      if (dados?.telefone === "0") {
        throw new Error('HTTP 500: {"erro":"telefone invalido: 0"}');
      }
      return { ok: true };
    };

    // drena ate estabilizar
    for (let i = 0; i < 12; i++) await _drenarParaTeste();

    assert.equal(tamanhoDaQuarentena(), 1, "o item impossivel deve estar na quarentena");
    assert.equal(tamanhoDaFila(), 0, "todo o resto deve ter passado");

    const entregues = chamadas.filter((c) => c.acao !== "mensagem" || c.dados.telefone !== "0");
    assert.ok(entregues.some((c) => c.acao === "sync.contabilizar"), "sync.contabilizar precisa avancar");
    assert.ok(entregues.some((c) => c.acao === "sync.concluir"), "sync.concluir precisa avancar");
    assert.ok(entregues.some((c) => c.dados?.telefone === "5551999998888"), "mensagem real precisa passar");
  });

  test("nada e apagado em silencio: o item fica em disco com o motivo", async () => {
    enfileirar("mensagem", { telefone: "0" });
    responder = async () => { throw new Error('HTTP 500: {"erro":"telefone invalido: 0"}'); };
    for (let i = 0; i < 8; i++) await _drenarParaTeste();

    const q = quarentena();
    assert.equal(q.length, 1);
    const conteudo = JSON.parse(readFileSync(join(base, "quarentena", q[0]), "utf8"));
    assert.equal(conteudo.dados.telefone, "0", "o evento original precisa continuar integro");
    const motivo = q[0].replace(/\.json$/, ".motivo.json");
    assert.ok(existsSync(join(base, "quarentena", motivo)), "precisa gravar o motivo ao lado");
    assert.match(JSON.parse(readFileSync(join(base, "quarentena", motivo), "utf8")).erro, /telefone invalido/);
  });

  test("CRM FORA DO AR nunca quarentena - o item espera", async () => {
    // A diferenca que protege o requisito "nao perder contato": falha de
    // infraestrutura melhora sozinha, recusa de conteudo nao.
    enfileirar("mensagem", { telefone: "5551999998888" });
    responder = async () => { throw new Error("fetch failed: ECONNREFUSED"); };
    for (let i = 0; i < 15; i++) await _drenarParaTeste();

    assert.equal(tamanhoDaQuarentena(), 0, "queda de rede nao pode quarentenar nada");
    assert.equal(tamanhoDaFila(), 1, "o item continua esperando");
  });

  test("500 sem corpo de recusa tambem espera (pode ser a plataforma)", async () => {
    enfileirar("mensagem", { telefone: "5551999998888" });
    responder = async () => { throw new Error("HTTP 500: Internal Server Error"); };
    for (let i = 0; i < 15; i++) await _drenarParaTeste();
    assert.equal(tamanhoDaQuarentena(), 0);
    assert.equal(tamanhoDaFila(), 1);
  });

  test("quarentenar reinicia a espera - dois itens impossiveis nao levam uma eternidade", async () => {
    // Tirar item da frente e progresso. Se a espera nao voltasse ao inicio,
    // cada impossivel herdaria o backoff do anterior e a fila andaria um passo
    // a cada dez minutos, com mensagem real parada atras.
    enfileirar("mensagem", { telefone: "0" });
    enfileirar("mensagem", { telefone: "00" });
    enfileirar("mensagem", { telefone: "5551999998888" });
    responder = async (_a, d) => {
      if (!/^[1-9]/.test(String(d.telefone))) {
        throw new Error('HTTP 500: {"erro":"telefone invalido"}');
      }
      return { ok: true };
    };
    for (let i = 0; i < 14; i++) await _drenarParaTeste();
    assert.equal(tamanhoDaQuarentena(), 2);
    assert.equal(tamanhoDaFila(), 0);
    assert.ok(chamadas.some((c) => c.dados.telefone === "5551999998888"));
  });

  test("a ordem e preservada entre os itens que passam", async () => {
    enfileirar("mensagem", { telefone: "5551900000001" });
    enfileirar("mensagem", { telefone: "5551900000002" });
    enfileirar("mensagem", { telefone: "5551900000003" });
    await _drenarParaTeste();
    assert.deepEqual(chamadas.map((c) => c.dados.telefone),
      ["5551900000001", "5551900000002", "5551900000003"]);
  });
});

process.on("exit", () => rmSync(base, { recursive: true, force: true }));

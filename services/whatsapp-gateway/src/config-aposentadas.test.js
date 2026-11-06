// APOSENTAR UM NÚMERO — o que trava este arquivo.
//
// POR QUE ELE EXISTE: em 08/10/2026 o Cobrança saiu do ar e só o Comercial
// ficou. O jeito "óbvio" de fazer isso era tirar `cobranca` de `SESSOES` no
// fly.toml — e NÃO funciona: em produção `SESSOES` é um SECRET do Fly, e secret
// vence o `[env]` do arquivo. O repositório diria uma coisa e o gateway faria
// outra, reconectando e pedindo QR Code de um número aposentado.
//
// `SESSOES_APOSENTADAS` existe para que a aposentadoria valha pelo DEPLOY,
// sobrevivendo a um secret desatualizado. O que estes testes garantem:
//
//   1. a chave aposentada não vira sessão — e sessão que não existe não
//      reconecta, não pede QR e não envia;
//   2. os outros números continuam de pé, inteiros;
//   3. aposentar TODOS recusa a subida, em vez de um gateway vivo e mudo.
//
// Nada aqui apaga credencial: a lista só decide quem sobe.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DADOS_DIR = mkdtempSync(join(tmpdir(), "wa-config-"));
process.env.CRM_URL = "http://127.0.0.1:1";
process.env.CRM_SEGREDO = "x".repeat(64);
process.env.GATEWAY_TOKEN = "y".repeat(64);

// `config.js` lê o ambiente UMA VEZ, no import, e o ESM guarda o módulo em
// cache. A query serve só para forçar uma avaliação nova a cada cenário — sem
// ela, o segundo caso leria a configuração do primeiro.
let versao = 0;
async function carregarConfig({ sessoes, aposentadas }) {
  process.env.SESSOES = sessoes;
  if (aposentadas === undefined) delete process.env.SESSOES_APOSENTADAS;
  else process.env.SESSOES_APOSENTADAS = aposentadas;

  const avisos = [];
  const consoleWarn = console.warn;
  const consoleError = console.error;
  const exit = process.exit;
  console.warn = (m) => avisos.push(String(m));
  console.error = (m) => avisos.push(String(m));
  // `config.js` chama `process.exit(1)` quando a configuração é inválida — e
  // isso mataria o processo de teste junto. Virar exceção deixa o teste provar
  // que a recusa aconteceu.
  process.exit = (codigo) => {
    throw new Error(`process.exit(${codigo})`);
  };
  try {
    const { config } = await import(`./config.js?v=${++versao}`);
    return { chaves: config.sessoes.map((s) => s.chave), avisos, recusou: false };
  } catch (erro) {
    // A recusa é um comportamento a testar como qualquer outro, e o log dela é
    // a parte que importa — por isso volta junto, em vez de propagar.
    if (!/process\.exit/.test(String(erro?.message))) throw erro;
    return { chaves: [], avisos, recusou: true };
  } finally {
    console.warn = consoleWarn;
    console.error = consoleError;
    process.exit = exit;
  }
}

describe("SESSOES_APOSENTADAS", () => {
  test("sem a variavel, nada muda: as duas sessoes sobem", async () => {
    const { chaves } = await carregarConfig({ sessoes: "comercial,cobranca" });
    assert.deepEqual(chaves, ["comercial", "cobranca"]);
  });

  test("a chave aposentada nao vira sessao, e a outra fica intacta", async () => {
    // O caso real: o secret do Fly continua listando `cobranca`, e mesmo assim
    // o número não sobe. Sem sessão não há reconexão automática nem pedido de
    // QR Code — era exatamente o que precisava parar.
    const { chaves } = await carregarConfig({
      sessoes: "comercial,cobranca",
      aposentadas: "cobranca",
    });
    assert.deepEqual(chaves, ["comercial"]);
  });

  test("aposentar diz em voz alta POR QUE o numero nao subiu", async () => {
    // Canal ausente em silêncio é diagnóstico de horas: já se perdeu tempo com
    // o Cobrança fora de SESSOES, quando conectar voltava 502 sem explicação.
    const { avisos } = await carregarConfig({
      sessoes: "comercial,cobranca",
      aposentadas: "cobranca",
    });
    const sobreCobranca = avisos.find((m) => m.includes("cobranca"));
    assert.ok(sobreCobranca, "esperava aviso nomeando a sessao aposentada");
    assert.match(sobreCobranca, /APOSENTADA/);
  });

  test("espaco e MAIUSCULA nao salvam o numero aposentado", async () => {
    // A chave é normalizada para minúsculas em `whatsapp_canais` e no gateway.
    // Uma divergência de caixa aqui seria falha que não avisa: a lista pareceria
    // certa e o número continuaria reconectando.
    const { chaves } = await carregarConfig({
      sessoes: "comercial, Cobranca",
      aposentadas: " COBRANCA ",
    });
    assert.deepEqual(chaves, ["comercial"]);
  });

  test("funciona tambem no formato JSON de SESSOES", async () => {
    const { chaves } = await carregarConfig({
      sessoes: '[{"chave":"comercial"},{"chave":"cobranca"}]',
      aposentadas: "cobranca",
    });
    assert.deepEqual(chaves, ["comercial"]);
  });

  test("chave aposentada que nem esta em SESSOES nao atrapalha", async () => {
    // O Piloto foi aposentado antes, tirando a chave de SESSOES. Listar os dois
    // não pode derrubar o Comercial.
    const { chaves } = await carregarConfig({
      sessoes: "comercial",
      aposentadas: "cobranca,piloto",
    });
    assert.deepEqual(chaves, ["comercial"]);
  });

  test("aposentar TODOS recusa subir, dizendo que a causa foi a aposentadoria", async () => {
    // Um gateway no ar sem nenhuma sessão recebe healthcheck verde e não atende
    // ninguém. Melhor morrer — e morrer distinguindo "aposentei todos" de
    // "esqueci de preencher SESSOES", que se resolvem de formas opostas.
    const { recusou, avisos } = await carregarConfig({
      sessoes: "comercial",
      aposentadas: "comercial",
    });
    assert.equal(recusou, true);
    assert.ok(
      avisos.some((m) => m.includes("SESSOES_APOSENTADAS")),
      `esperava a causa no log, veio: ${JSON.stringify(avisos)}`,
    );
  });
});

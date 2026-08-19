// tratarHistorico DE PONTA A PONTA, com lotes simulados.
//
// POR QUE ESTE ARQUIVO EXISTE: o histórico do WhatsApp vem UMA VEZ por
// pareamento. Perdemos dois seguidos, por causas diferentes, e nenhum dos dois
// teria sido pego pelos testes que existiam:
//
//   1º pareamento — o filtro descartava todo `@lid`. Os testes cobriam as
//      funções auxiliares, que estavam corretas; o defeito estava em QUEM as
//      usava.
//   2º pareamento — `Cannot access 'novosVinculos' before initialization`. Erro
//      de execução: `node --check` passa, teste de função auxiliar passa, e o
//      manipulador morre na primeira linha ao receber o lote real.
//
// Por isso aqui o caminho é o de verdade: o lote entra em `tratarHistorico`, o
// evento é gravado na fila EM DISCO, a fila é drenada contra um CRM duplo, e o
// que chega do outro lado é conferido. Nada de testar só as peças.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "wa-hist-"));
process.env.DADOS_DIR = base;
process.env.CRM_URL = "http://127.0.0.1:1";
process.env.CRM_SEGREDO = "x".repeat(64);
process.env.GATEWAY_TOKEN = "y".repeat(64);
process.env.SESSOES = "piloto";

const { criarSessao, _usarCrmParaTeste } = await import("./sessao.js");
const { _drenarParaTeste, _usarEntregadorParaTeste, tamanhoDaFila, tamanhoDaQuarentena } =
  await import("./outbox.js");

// ---------------------------------------------------------------------------
// CRM duplo: registra tudo o que recebe e pode recusar o que quisermos.
// ---------------------------------------------------------------------------
const recebido = [];
let recusar = () => null; // devolve string de erro para recusar

_usarCrmParaTeste(async (acao, dados) => {
  if (acao === "sync.abrir") return "sync-de-teste";
  recebido.push({ acao, dados });
  return { ok: true };
});
_usarEntregadorParaTeste(async (acao, dados) => {
  const erro = recusar(acao, dados);
  if (erro) throw new Error(`HTTP 500: {"erro":"${erro}"}`);
  recebido.push({ acao, dados });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Construtores de lote parecidos com o que o WhatsApp manda de verdade.
// ---------------------------------------------------------------------------
const LID = (n) => `1721380000000${n}@lid`;
const TEL = (n) => `55519999${String(n).padStart(5, "0")}@s.whatsapp.net`;

function msg(jid, id, { fromMe = false, texto = "oi", ts = 1755600000 } = {}) {
  return {
    key: { remoteJid: jid, id, fromMe },
    message: { conversation: texto },
    messageTimestamp: ts,
    pushName: "Fulano",
  };
}

async function drenarTudo(vezes = 20) {
  for (let i = 0; i < vezes; i++) await _drenarParaTeste();
}

let sessao;

beforeEach(() => {
  recebido.length = 0;
  recusar = () => null;
  for (const d of ["fila", "quarentena"]) {
    if (existsSync(join(base, d))) for (const f of readdirSync(join(base, d))) rmSync(join(base, d, f));
  }
  sessao = criarSessao({ chave: "piloto" });
});

// REQUISITO 11 — qualquer exceção dentro de `tratarHistorico` reprova o teste.
//
// Aqui a função é chamada DIRETO, de forma síncrona. Se ela lançar, a exceção
// sobe e o caso falha na hora. Em produção ela é chamada de dentro de um
// `async`, e foi por isso que a exceção do segundo pareamento virou "promessa
// rejeitada sem tratamento" e passou despercebida: ninguém estava olhando.
// O runner do Node também reprova por rejeição não tratada, o que fecha o cerco.

const mensagensEntregues = () => recebido.filter((r) => r.acao === "mensagem").map((r) => r.dados);

describe("tratarHistorico ponta a ponta", () => {
  test("1+3. lote com lidJid/pnJid cria vinculo e resolve a mensagem @lid", async () => {
    sessao._paraTeste.tratarHistorico({
      chats: [{ id: LID(1), lidJid: LID(1), pnJid: TEL(1), name: "Aluno Um" }],
      contacts: [],
      messages: [msg(LID(1), "M1")],
      syncType: 2,
    });
    await drenarTudo();

    assert.equal(sessao._paraTeste.vinculos().tamanho, 1, "o vinculo tem de ser aprendido");
    const m = mensagensEntregues();
    assert.equal(m.length, 1);
    assert.equal(m[0].telefone, "5551999900001", "a @lid tem de virar telefone");
    assert.equal(sessao._paraTeste.descartes().resolvidos_por_lid, 1);
  });

  test("2. contato com lid/jid tambem cria vinculo", async () => {
    sessao._paraTeste.tratarHistorico({
      chats: [],
      contacts: [{ id: LID(2), lid: LID(2), jid: TEL(2), name: "Aluno Dois" }],
      messages: [msg(LID(2), "M2")],
      syncType: 2,
    });
    await drenarTudo();
    assert.equal(mensagensEntregues()[0].telefone, "5551999900002");
  });

  test("4. @lid SEM vinculo fica retida e e reprocessada quando o vinculo chega", async () => {
    // Os lotes nao vem em ordem garantida: a mensagem pode chegar antes do
    // contato que a identifica. Descartar na hora foi o erro do 1o pareamento.
    await sessao._paraTeste.garantirSync();

    sessao._paraTeste.tratarHistorico({
      chats: [], contacts: [], messages: [msg(LID(3), "M3")], syncType: 2,
    });
    await drenarTudo();
    assert.equal(mensagensEntregues().length, 0, "ainda nao da para resolver");
    assert.equal(sessao._paraTeste.descartes().LID_SEM_VINCULO, 0, "nao pode contar como descarte ainda");

    // o vinculo chega no lote seguinte
    sessao._paraTeste.tratarHistorico({
      chats: [{ lidJid: LID(3), pnJid: TEL(3) }], contacts: [], messages: [], syncType: 2,
    });
    await sessao._paraTeste.fecharSync();
    await drenarTudo();

    const m = mensagensEntregues();
    assert.equal(m.length, 1, "a retida tem de ser recuperada no fim");
    assert.equal(m[0].telefone, "5551999900003");
  });

  test("4b. o que nunca resolve e registrado em disco, nao sumido", async () => {
    await sessao._paraTeste.garantirSync();
    sessao._paraTeste.tratarHistorico({
      chats: [], contacts: [], messages: [msg(LID(9), "M9")], syncType: 2,
    });
    await sessao._paraTeste.fecharSync();

    const registros = readdirSync(base).filter((n) => n.startsWith("lid-sem-vinculo-"));
    assert.equal(registros.length, 1, "precisa gravar o que nao resolveu");
    const conteudo = JSON.parse(readFileSync(join(base, registros[0]), "utf8"));
    assert.equal(conteudo[0].wamid, "M9");
    for (const r of registros) rmSync(join(base, r));
  });

  test("5. telefone invalido NUNCA entra na fila", async () => {
    // `0@s.whatsapp.net` passa por isJidUser e virava telefone "0", que o CRM
    // recusa para sempre. Foi o que congelou a fila no 1o pareamento.
    sessao._paraTeste.tratarHistorico({
      chats: [], contacts: [],
      messages: [msg("0@s.whatsapp.net", "S1"), msg(TEL(4), "OK1")],
      syncType: 2,
    });
    await drenarTudo();

    const m = mensagensEntregues();
    assert.equal(m.length, 1, "so a valida pode passar");
    assert.equal(m[0].telefone, "5551999900004");
    assert.ok(!m.some((x) => x.telefone === "0"), "telefone 0 nao pode existir na fila");
    assert.equal(sessao._paraTeste.descartes().SISTEMA, 1);
  });

  test("6. item impossivel vai para quarentena e nao bloqueia os seguintes", async () => {
    sessao._paraTeste.tratarHistorico({
      chats: [], contacts: [],
      messages: [msg(TEL(5), "B1"), msg(TEL(6), "B2"), msg(TEL(7), "B3")],
      syncType: 2,
    });
    recusar = (_a, d) => (d?.wamid === "B1" ? "recusado de proposito" : null);
    await drenarTudo(30);

    assert.equal(tamanhoDaQuarentena(), 1);
    assert.equal(tamanhoDaFila(), 0, "o resto tem de passar");
    const ids = mensagensEntregues().map((d) => d.wamid);
    assert.deepEqual(ids, ["B2", "B3"]);
  });

  test("7+8. sync.contabilizar avanca e sync.concluir fecha", async () => {
    await sessao._paraTeste.garantirSync();
    sessao._paraTeste.tratarHistorico({
      chats: [{ id: TEL(8), pnJid: TEL(8) }], contacts: [{ id: TEL(8), jid: TEL(8) }],
      messages: [msg(TEL(8), "C1")], isLatest: false, syncType: 2,
    });
    await sessao._paraTeste.fecharSync();
    await drenarTudo();

    const contab = recebido.filter((r) => r.acao === "sync.contabilizar");
    assert.equal(contab.length, 1, "sync.contabilizar precisa avancar");
    assert.equal(contab[0].dados.conversas, 1);
    assert.equal(contab[0].dados.mensagens, 1);
    assert.equal(recebido.filter((r) => r.acao === "sync.concluir").length, 1, "sync.concluir precisa fechar");
  });

  test("9. historico importado NAO vira nao lido", async () => {
    // O CRM so nao conta como nao lida quando a origem diz SYNC_INICIAL. Se o
    // gateway marcasse TEMPO_REAL, o primeiro pareamento nasceria com milhares
    // de conversas falsamente nao lidas.
    sessao._paraTeste.tratarHistorico({
      chats: [], contacts: [], messages: [msg(TEL(10), "D1"), msg(TEL(11), "D2", { fromMe: true })],
      syncType: 2,
    });
    await drenarTudo();
    const m = mensagensEntregues();
    assert.equal(m.length, 2);
    assert.ok(m.every((x) => x.origem === "SYNC_INICIAL"), "tudo do historico e SYNC_INICIAL");
    assert.equal(m.find((x) => x.wamid === "D2").direcao, "SAIDA", "fromMe entra como SAIDA");
  });

  test("10+11. lote FULL grande passa inteiro, sem excecao", async () => {
    // Reproduz a forma do lote que chegou nos dois pareamentos: centenas de
    // conversas, milhares de mensagens, mistura de @lid, telefone, grupo,
    // status e sistema.
    const chats = [];
    const contacts = [];
    const messages = [];
    for (let i = 0; i < 300; i++) {
      chats.push({ id: LID(100 + i), lidJid: LID(100 + i), pnJid: TEL(100 + i), name: `Aluno ${i}` });
      contacts.push({ id: LID(100 + i), lid: LID(100 + i), jid: TEL(100 + i) });
    }
    for (let i = 0; i < 300; i++) {
      for (let k = 0; k < 10; k++) messages.push(msg(LID(100 + i), `F${i}-${k}`));
    }
    // ruido que o WhatsApp manda junto
    messages.push(msg("0@s.whatsapp.net", "SYS"));
    messages.push(msg("status@broadcast", "ST"));
    messages.push(msg("120363000000000000@g.us", "GR"));
    messages.push(msg("55519@newsletter", "NW"));
    messages.push({ key: { remoteJid: TEL(1), id: null }, message: {}, messageTimestamp: 1 });

    await sessao._paraTeste.garantirSync();
    sessao._paraTeste.tratarHistorico({
      chats, contacts, messages, isLatest: true, syncType: 2, progress: 100,
    });
    await sessao._paraTeste.fecharSync();
    await drenarTudo(80);

    const d = sessao._paraTeste.descartes();
    assert.equal(d.aceitos, 3000, "todas as 3.000 mensagens de gente tem de ser aceitas");
    assert.equal(d.resolvidos_por_lid, 3000, "todas vieram por @lid e tem de ser resolvidas");
    assert.equal(d.GRUPO, 1);
    assert.equal(d.BROADCAST, 1);
    assert.equal(d.CANAL, 1);
    assert.equal(d.SISTEMA, 1);
    assert.equal(d.SEM_ID, 1);
    assert.equal(d.LID_SEM_VINCULO, 0);
    assert.equal(tamanhoDaQuarentena(), 0, "nada pode cair na quarentena num lote saudavel");

    const m = mensagensEntregues();
    assert.equal(m.length, 3000, "as 3.000 tem de chegar ao CRM");
    assert.ok(m.every((x) => /^5551/.test(x.telefone)), "nenhum telefone estranho");
  });

  test("11b. excecao dentro de tratarHistorico sobe - nao e engolida", () => {
    // Prova do controle: se um estouro dentro desta função pudesse ser
    // engolido, todos os testes acima poderiam passar com o manipulador morto.
    // Foi assim que o segundo histórico se perdeu sem ninguém ver.
    assert.throws(
      () => sessao._paraTeste.tratarHistorico({ chats: 5, contacts: [], messages: [] }),
      /is not iterable/,
      "um erro interno precisa chegar a quem chamou",
    );
  });
});

// ---------------------------------------------------------------------------
// MENSAGEM AO VIVO endereçada por LID.
//
// Uma mensagem real de outro celular chegou e foi DESCARTADA: o `remoteJid`
// vinha `@lid`, o mapa de vínculos estava vazio (ele se alimenta do histórico,
// que não existe mais) e o caminho ao vivo não tinha outra fonte.
//
// Só que o telefone vinha no próprio evento, em `key.senderPn`, e nós o
// ignorávamos. Estes testes trancam esse comportamento.
// ---------------------------------------------------------------------------
describe("tratarMensagensNovas com @lid", () => {
  const LIDV = "172138000009999@lid";
  const PNV = "5551988887777@s.whatsapp.net";

  function aoVivo(id, { senderPn = null, participantPn = null } = {}) {
    return {
      type: "notify",
      messages: [{
        key: { remoteJid: LIDV, id, fromMe: false, senderLid: LIDV, senderPn, participantPn },
        message: { conversation: "oi, quero negociar" },
        messageTimestamp: 1755600000,
        pushName: "Aluno",
      }],
    };
  }

  test("1-5. @lid com senderPn: entra na fila, conta e aprende o vinculo", async () => {
    sessao._paraTeste.tratarMensagensNovas(aoVivo("V1", { senderPn: PNV }));

    // 1. entrou na fila persistente (antes de qualquer entrega)
    assert.equal(tamanhoDaFila(), 1, "a mensagem tem de estar na fila em disco");

    // 2 e 3. contadores
    const d = sessao._paraTeste.descartes();
    assert.equal(d.aceitos, 1, "aceitas tem de incrementar");
    assert.equal(d.resolvidos_por_lid, 1, "resolvidas_por_lid tem de incrementar");
    assert.equal(d.LID_SEM_VINCULO, 0, "nao pode contar como descarte");

    // 4. o par ficou no mapa
    assert.equal(sessao._paraTeste.vinculos().tamanho, 1);
    assert.equal(sessao._paraTeste.vinculos().resolver(LIDV), "5551988887777");

    // 5. o webhook recebe telefone valido
    await drenarTudo();
    const m = mensagensEntregues();
    assert.equal(m.length, 1);
    assert.equal(m[0].telefone, "5551988887777");
    assert.equal(m[0].direcao, "ENTRADA");
    assert.equal(m[0].origem, "TEMPO_REAL");
  });

  test("6. a mensagem SEGUINTE do mesmo LID passa sem repetir senderPn", async () => {
    sessao._paraTeste.tratarMensagensNovas(aoVivo("V1", { senderPn: PNV }));
    // agora sem nenhum campo de telefone: tem de resolver pelo mapa aprendido
    sessao._paraTeste.tratarMensagensNovas(aoVivo("V2"));
    await drenarTudo();

    const m = mensagensEntregues();
    assert.equal(m.length, 2, "as duas tem de chegar");
    assert.ok(m.every((x) => x.telefone === "5551988887777"));
    assert.equal(sessao._paraTeste.descartes().aceitos, 2);
  });

  test("participantPn tambem serve quando senderPn nao vem", async () => {
    sessao._paraTeste.tratarMensagensNovas(aoVivo("V3", { participantPn: PNV }));
    await drenarTudo();
    assert.equal(mensagensEntregues()[0].telefone, "5551988887777");
  });

  test("sem senderPn e sem vinculo continua sendo descarte contado - nada de fallback inventado", async () => {
    // Se o telefone nao vem e nao ha vinculo, NAO se inventa numero a partir do
    // LID: aquilo nao e telefone de ninguem. Fica contado para aparecer.
    sessao._paraTeste.tratarMensagensNovas(aoVivo("V4"));
    assert.equal(tamanhoDaFila(), 0);
    assert.equal(sessao._paraTeste.descartes().LID_SEM_VINCULO, 1);
    assert.equal(sessao._paraTeste.descartes().aceitos, 0);
  });

  test("senderPn invalido nao vira telefone", async () => {
    sessao._paraTeste.tratarMensagensNovas(aoVivo("V5", { senderPn: "0@s.whatsapp.net" }));
    assert.equal(tamanhoDaFila(), 0);
    assert.equal(sessao._paraTeste.descartes().LID_SEM_VINCULO, 1);
  });

  test("conversa por telefone comum segue funcionando", async () => {
    sessao._paraTeste.tratarMensagensNovas({
      type: "notify",
      messages: [{
        key: { remoteJid: TEL(50), id: "V6", fromMe: false },
        message: { conversation: "oi" },
        messageTimestamp: 1755600000,
      }],
    });
    await drenarTudo();
    assert.equal(mensagensEntregues()[0].telefone, "5551999900050");
    assert.equal(sessao._paraTeste.descartes().resolvidos_por_lid, 0, "esta nao passou por LID");
  });
});

process.on("exit", () => rmSync(base, { recursive: true, force: true }));

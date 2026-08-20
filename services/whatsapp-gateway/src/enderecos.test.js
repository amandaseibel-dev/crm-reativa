// Testes do que causou o incidente de 2026-08-19. Rodar: npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  VinculosLid, resolverEndereco, telefoneValido, telefoneDaChave, criarContadores, resumoDescartes,
} from "./enderecos.js";

const LID = "172138000000001@lid";
const LID_DISPOSITIVO = "172138000000001:85@lid";
const TEL = "5551999998888@s.whatsapp.net";

describe("telefoneValido", () => {
  test("aceita numero brasileiro com DDI", () => {
    assert.equal(telefoneValido("5551999998888"), true);
    assert.equal(telefoneValido("555133334444"), true);
  });

  test("recusa o endereco de sistema que travou a fila", () => {
    // Este e o caso exato do incidente: `0@s.whatsapp.net` virava telefone "0",
    // o CRM recusava e a fila congelava atras dele.
    assert.equal(telefoneValido("0"), false);
    assert.equal(telefoneValido("00"), false);
    assert.equal(telefoneValido("000000000000"), false);
  });

  test("recusa lixo e tamanhos impossiveis", () => {
    assert.equal(telefoneValido(""), false);
    assert.equal(telefoneValido("abc"), false);
    assert.equal(telefoneValido("55519"), false);
    assert.equal(telefoneValido("5551999998888000000"), false);
    assert.equal(telefoneValido("055199999888"), false);
    assert.equal(telefoneValido(null), false);
  });
});

describe("VinculosLid — o vinculo que o historico traz de graca", () => {
  test("aprende pelo par lidJid/pnJid das conversas", () => {
    const v = new VinculosLid();
    const novos = v.aprender({ chats: [{ id: LID, lidJid: LID, pnJid: TEL }] });
    assert.ok(novos >= 1);
    assert.equal(v.resolver(LID), "5551999998888");
  });

  test("aprende pelo par lid/jid dos contatos", () => {
    const v = new VinculosLid();
    v.aprender({ contacts: [{ id: LID, lid: LID, jid: TEL }] });
    assert.equal(v.resolver(LID), "5551999998888");
  });

  test("resolve mesmo com sufixo de dispositivo no LID", () => {
    const v = new VinculosLid();
    v.aprender({ chats: [{ lidJid: LID, pnJid: TEL }] });
    assert.equal(v.resolver(LID_DISPOSITIVO), "5551999998888");
  });

  test("nao guarda vinculo para telefone invalido", () => {
    const v = new VinculosLid();
    v.aprender({ chats: [{ lidJid: LID, pnJid: "0@s.whatsapp.net" }] });
    assert.equal(v.tamanho, 0);
    assert.equal(v.resolver(LID), null);
  });

  test("nao explode com lote vazio ou campos ausentes", () => {
    const v = new VinculosLid();
    assert.doesNotThrow(() => v.aprender({}));
    assert.doesNotThrow(() => v.aprender({ chats: [{}], contacts: [{}] }));
    assert.equal(v.tamanho, 0);
  });
});

describe("resolverEndereco", () => {
  test("telefone comum passa direto", () => {
    assert.deepEqual(resolverEndereco(TEL, new VinculosLid()), { telefone: "5551999998888" });
  });

  test("LID COM vinculo e resolvido, nao descartado", () => {
    // O defeito que custou o historico: `@lid` era descartado sempre.
    const v = new VinculosLid();
    v.aprender({ chats: [{ lidJid: LID, pnJid: TEL }] });
    const r = resolverEndereco(LID_DISPOSITIVO, v);
    assert.equal(r.telefone, "5551999998888");
    assert.equal(r.viaLid, true);
  });

  test("LID SEM vinculo e descartado com motivo proprio", () => {
    const r = resolverEndereco(LID, new VinculosLid());
    assert.deepEqual(r, { motivo: "LID_SEM_VINCULO" });
  });

  test("mensagem de sistema nao vira telefone 0", () => {
    const r = resolverEndereco("0@s.whatsapp.net", new VinculosLid());
    assert.equal(r.telefone, undefined);
    assert.equal(r.motivo, "SISTEMA");
  });

  test("grupo, lista e canal tem motivos distintos", () => {
    const v = new VinculosLid();
    assert.equal(resolverEndereco("1312256457152370-1@g.us", v).motivo, "GRUPO");
    assert.equal(resolverEndereco("status@broadcast", v).motivo, "BROADCAST");
    assert.equal(resolverEndereco("123@newsletter", v).motivo, "CANAL");
  });

  test("sem jid nenhum", () => {
    assert.deepEqual(resolverEndereco(null, new VinculosLid()), { motivo: "SEM_ID" });
  });

  test("NUNCA devolve telefone e motivo ao mesmo tempo", () => {
    const v = new VinculosLid();
    v.aprender({ chats: [{ lidJid: LID, pnJid: TEL }] });
    for (const j of [TEL, LID, LID_DISPOSITIVO, "0@s.whatsapp.net", "x@g.us", null]) {
      const r = resolverEndereco(j, v);
      assert.ok(Boolean(r.telefone) !== Boolean(r.motivo),
        `${j}: precisa ter telefone OU motivo, nunca os dois nem nenhum`);
    }
  });

  test("todo telefone devolvido passa na validacao", () => {
    const v = new VinculosLid();
    v.aprender({ chats: [{ lidJid: LID, pnJid: TEL }] });
    for (const j of [TEL, LID_DISPOSITIVO]) {
      assert.equal(telefoneValido(resolverEndereco(j, v).telefone), true);
    }
  });
});

describe("contadores", () => {
  test("resumo mostra so o que aconteceu", () => {
    const c = criarContadores();
    assert.equal(resumoDescartes(c), "nenhum");
    c.GRUPO = 3; c.LID_SEM_VINCULO = 12;
    assert.equal(resumoDescartes(c), "GRUPO=3 LID_SEM_VINCULO=12");
  });
});

// ---------------------------------------------------------------------------
// Baileys 7: o telefone mudou de campo — e isso PERDEU MENSAGEM em produção.
//
// Em 19/08/2026, com a 7.0.0-rc14 no ar, 3 de 3 mensagens de entrada foram
// descartadas. Elas decodificavam perfeitamente e caíam em LID_SEM_VINCULO
// porque `telefoneDaChave` só olhava `senderPn`/`participantPn` — campos que a
// 6.7.24 preenchia e a 7.x deixou de preencher. O telefone estava ali o tempo
// todo, em `remoteJidAlt`.
//
// A chave abaixo é a REAL, copiada do log do incidente.
// ---------------------------------------------------------------------------
describe("telefoneDaChave — chave da Baileys 7", () => {
  const CHAVE_REAL = {
    remoteJid: "173310721683688@lid",
    remoteJidAlt: "555195334008@s.whatsapp.net",
    fromMe: false,
    id: "3A856A73C61EB63FBCCF",
    addressingMode: "lid",
  };

  test("extrai o telefone de remoteJidAlt quando remoteJid vem em @lid", () => {
    const r = telefoneDaChave(CHAVE_REAL);
    assert.deepEqual(r, { user: "555195334008", jid: "555195334008@s.whatsapp.net" });
  });

  test("a mensagem do incidente passa a ser ACEITA, nao descartada", () => {
    const vinculos = new VinculosLid(); // vazio, como apos um restart
    const r = resolverEndereco(CHAVE_REAL.remoteJid, vinculos, CHAVE_REAL);
    assert.equal(r.motivo, undefined, "nao pode mais cair em LID_SEM_VINCULO");
    assert.equal(r.telefone, "555195334008");
    assert.equal(r.viaLid, true);
  });

  test("e o vinculo fica aprendido para as proximas", () => {
    const vinculos = new VinculosLid();
    resolverEndereco(CHAVE_REAL.remoteJid, vinculos, CHAVE_REAL);
    assert.equal(vinculos.resolver("173310721683688@lid"), "555195334008");
  });

  test("participantAlt tambem serve (grupo)", () => {
    const r = telefoneDaChave({ participantAlt: "5551999998888@s.whatsapp.net" });
    assert.equal(r.user, "5551999998888");
  });

  // -------------------------------------------------------------------------
  // Os limites: nada de telefone inventado.
  // -------------------------------------------------------------------------
  test("NAO infere telefone a partir do proprio LID", () => {
    // `Alt` e "o outro endereco", nao "o telefone". Numa conversa endereçada
    // por PN ele traz o LID — aceitar isso criaria um numero que nao existe.
    assert.equal(telefoneDaChave({ remoteJidAlt: "173310721683688@lid" }), null);
    assert.equal(telefoneDaChave({ participantAlt: "173310721683688@lid" }), null);
  });

  test("sem PN nenhum continua sendo descarte EXPLICITO", () => {
    const vinculos = new VinculosLid();
    const semPn = { remoteJid: "173310721683688@lid", fromMe: false, id: "X", addressingMode: "lid" };
    assert.equal(telefoneDaChave(semPn), null);
    const r = resolverEndereco(semPn.remoteJid, vinculos, semPn);
    assert.equal(r.motivo, "LID_SEM_VINCULO", "descarte precisa continuar contado por motivo");
    assert.equal(r.telefone, undefined, "nunca inventar telefone");
  });

  test("o JID de sistema no Alt nao vira telefone", () => {
    assert.equal(telefoneDaChave({ remoteJidAlt: "0@s.whatsapp.net" }), null);
  });

  // -------------------------------------------------------------------------
  // Compatibilidade: os campos antigos continuam valendo e vem PRIMEIRO.
  // -------------------------------------------------------------------------
  test("senderPn continua funcionando (6.7.24)", () => {
    const r = telefoneDaChave({ senderPn: "5551988887777@s.whatsapp.net" });
    assert.equal(r.user, "5551988887777");
  });

  test("senderPn tem PRIORIDADE sobre remoteJidAlt", () => {
    const r = telefoneDaChave({
      senderPn: "5551988887777@s.whatsapp.net",
      remoteJidAlt: "555195334008@s.whatsapp.net",
    });
    assert.equal(r.user, "5551988887777", "o campo antigo decide quando existe");
  });

  test("participantPn continua funcionando", () => {
    const r = telefoneDaChave({ participantPn: "5551977776666@s.whatsapp.net" });
    assert.equal(r.user, "5551977776666");
  });
});

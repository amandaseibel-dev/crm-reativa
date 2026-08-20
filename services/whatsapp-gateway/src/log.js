// Log estruturado. Cada linha é JSON com a sessão embutida — sem isso, com dois
// números no mesmo processo, não se descobre qual deles caiu.
import pino from "pino";

// Mascara preservando o que serve para DIAGNÓSTICO e apagando o que identifica
// a pessoa.
//
// POR QUE NÃO SIMPLESMENTE "[oculto]": metade do trabalho de investigação deste
// serviço foi feito olhando o FORMATO do endereço — `@lid` contra
// `@s.whatsapp.net`, 12 dígitos contra 13. Foi assim que se descobriu o JID
// errado no envio e a mudança de campo da Baileys 7. Apagar o valor inteiro
// cegaria exatamente a análise que precisamos poder fazer.
//
// Então: os dígitos viram `#`, o sufixo do JID fica. `555195334008@s.whatsapp.net`
// vira `############@s.whatsapp.net` — dá para ver que é PN de 12 dígitos, e não
// dá para saber de quem.
//
// Nome de pessoa não tem formato que valha preservar: some inteiro.
function mascararPII(valor, caminho) {
  if (valor === null || valor === undefined) return valor;
  const campo = Array.isArray(caminho) ? caminho[caminho.length - 1] : String(caminho);

  if (campo === "notify" || campo === "verified_name" || campo === "pushName" ||
      campo === "nome_perfil" || campo === "verifiedName") {
    return "[nome oculto]";
  }

  const s = String(valor);
  const arroba = s.indexOf("@");
  if (arroba > 0) return "#".repeat(arroba) + s.slice(arroba);
  if (/^\d{6,}$/.test(s)) return "#".repeat(s.length);
  return "[oculto]";
}

export const log = pino({
  level: process.env.LOG_NIVEL || "info",
  base: { servico: "whatsapp-gateway" },
  // Conteúdo de mensagem NUNCA vai para o log: é dado pessoal de aluno (LGPD).
  // O que interessa é o QUE aconteceu, não o que a pessoa escreveu.
  //
  // A lista abaixo tem duas metades. A primeira é o que nós escrevemos. A
  // segunda é o que o BAILEYS escreve por conta própria — e era por ali que
  // telefone e nome de aluno saíam em claro, porque o logger é o mesmo objeto
  // passado para a biblioteca. A auditoria de 20/08/2026 encontrou 15 telefones
  // e vários nomes assim, em `msgAttrs`.
  redact: {
    paths: [
      // --- conteúdo (some inteiro) ---
      "texto", "*.texto", "payload", "*.payload", "qr", "*.qr",
      "conversation", "*.conversation", "message", "*.message",
      // --- nossos campos ---
      "jid", "*.jid", "telefone", "*.telefone", "nome_perfil", "*.nome_perfil",
      // --- chave da mensagem (Baileys) ---
      "key.remoteJid", "key.remoteJidAlt", "key.participant", "key.participantAlt",
      "key.senderPn", "key.senderLid", "key.participantPn", "key.participantLid",
      "*.key.remoteJid", "*.key.remoteJidAlt", "*.key.participant",
      // --- atributos do nó (Baileys) — a fonte do vazamento ---
      "msgAttrs.from", "msgAttrs.recipient", "msgAttrs.participant",
      "msgAttrs.sender_pn", "msgAttrs.peer_recipient_pn", "msgAttrs.sender_lid",
      "msgAttrs.notify", "msgAttrs.verified_name",
      "*.msgAttrs.from", "*.msgAttrs.sender_pn", "*.msgAttrs.notify",
      // --- nome de perfil em qualquer lugar ---
      "notify", "*.notify", "pushName", "*.pushName",
      "verified_name", "*.verified_name",
    ],
    censor: mascararPII,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const logSessao = (chave) => log.child({ sessao: chave });

// Exportada só para o teste: a máscara precisa ser exercitada com os valores
// reais que apareceram no log de produção.
export const _mascararPII = mascararPII;

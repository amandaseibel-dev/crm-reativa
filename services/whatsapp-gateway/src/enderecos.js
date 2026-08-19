// Endereço de quem está do outro lado: de JID do WhatsApp para telefone.
//
// POR QUE ESTE ARQUIVO EXISTE — o incidente de 2026-08-19:
//
// No primeiro pareamento o WhatsApp entregou 285 conversas e ~5.800 mensagens.
// Aproveitamos DUAS. O filtro antigo descartava qualquer JID contendo `@lid`,
// e esta conta é endereçada por LID: na prática jogamos fora o histórico
// inteiro — que só vem uma vez. As duas que sobraram vinham do JID de sistema
// `0@s.whatsapp.net`, viraram `telefone: "0"`, o CRM recusou (com razão) e a
// fila congelou atrás delas.
//
// Duas lições viraram código aqui:
//
//   1. `@lid` NÃO é motivo para descartar. É um endereço anônimo, e o próprio
//      histórico traz o vínculo com o telefone: cada `Conversation` tem
//      `lidJid` + `pnJid`, e cada `Contact` tem `lid` + `jid`. Guardamos esse
//      vínculo e resolvemos. Só descartamos quando não há vínculo NENHUM.
//
//   2. Nada é enfileirado sem telefone plausível. `0` não é telefone. Item que
//      o CRM vai recusar sempre não pode nascer.
//
// E todo descarte é CONTADO POR MOTIVO. O silêncio foi o que fez o problema
// passar despercebido: a operação não tinha como saber que 5.800 mensagens
// tinham sido jogadas fora.
import { isJidUser, isLidUser, jidDecode } from "baileys";

export const MOTIVOS = [
  "GRUPO",
  "BROADCAST",
  "CANAL",
  "SISTEMA",
  "LID_SEM_VINCULO",
  "TELEFONE_INVALIDO",
  "SEM_ID",
  "SEM_CONTEUDO",
];

export function criarContadores() {
  const c = { aceitos: 0, resolvidos_por_lid: 0 };
  for (const m of MOTIVOS) c[m] = 0;
  return c;
}

// Telefone plausível: só dígitos, tamanho de número real com DDI, e nada de
// zeros à esquerda — `0`, `00`, `0@s.whatsapp.net` são endereços de sistema,
// não pessoas.
export function telefoneValido(t) {
  const s = String(t ?? "");
  if (!/^[1-9]\d{9,14}$/.test(s)) return false;
  return true;
}

// Guarda os pares LID <-> telefone que o WhatsApp manda junto do histórico e
// dos contatos. Sem isto, mensagem endereçada por LID não tem como virar
// telefone e seria descartada — foi exatamente o que aconteceu.
export class VinculosLid {
  constructor() {
    this.porLid = new Map();
  }

  get tamanho() {
    return this.porLid.size;
  }

  #userDe(jid) {
    if (!jid) return null;
    const d = jidDecode(jid);
    return d?.user || null;
  }

  registrar(lidJid, telefoneJid) {
    const lid = this.#userDe(lidJid);
    const tel = this.#userDe(telefoneJid);
    if (!lid || !telefoneValido(tel)) return false;
    if (this.porLid.get(lid) === tel) return false;
    this.porLid.set(lid, tel);
    return true;
  }

  // Aprende com um lote de histórico. `chats` são `proto.IConversation`
  // (trazem `lidJid`/`pnJid`) e `contacts` são o `Contact` do Baileys
  // (traz `lid`/`jid`).
  aprender({ chats, contacts } = {}) {
    let novos = 0;
    for (const c of contacts || []) {
      if (this.registrar(c?.lid, c?.jid)) novos++;
      // `id` pode vir em qualquer um dos dois formatos
      if (isLidUser(c?.id) && this.registrar(c.id, c?.jid)) novos++;
      if (isJidUser(c?.id) && this.registrar(c?.lid, c.id)) novos++;
    }
    for (const ch of chats || []) {
      if (this.registrar(ch?.lidJid, ch?.pnJid)) novos++;
      if (isLidUser(ch?.id) && this.registrar(ch.id, ch?.pnJid)) novos++;
      if (isJidUser(ch?.id) && this.registrar(ch?.lidJid, ch.id)) novos++;
    }
    return novos;
  }

  resolver(lidJid) {
    return this.porLid.get(this.#userDe(lidJid)) || null;
  }
}

// O coração: devolve `{ telefone }` OU `{ motivo }`. Nunca as duas coisas, e
// nunca `null` silencioso — quem chama é obrigado a contabilizar o motivo.
export function resolverEndereco(jid, vinculos) {
  if (!jid) return { motivo: "SEM_ID" };

  const texto = String(jid);
  if (texto.endsWith("@g.us")) return { motivo: "GRUPO" };
  if (texto.endsWith("@broadcast")) return { motivo: "BROADCAST" };
  if (texto.endsWith("@newsletter")) return { motivo: "CANAL" };

  if (isLidUser(texto)) {
    const tel = vinculos?.resolver(texto);
    if (tel) return { telefone: tel, viaLid: true };
    return { motivo: "LID_SEM_VINCULO" };
  }

  if (isJidUser(texto)) {
    const user = jidDecode(texto)?.user || "";
    // `0@s.whatsapp.net` e afins passam por `isJidUser`, mas são o WhatsApp
    // falando com a gente, não um aluno.
    if (!telefoneValido(user)) {
      return { motivo: /^\d*$/.test(user) && Number(user) === 0 ? "SISTEMA" : "TELEFONE_INVALIDO" };
    }
    return { telefone: user };
  }

  return { motivo: "TELEFONE_INVALIDO" };
}

// Resumo legível para o log: só o que não é zero, para a linha não virar ruído.
export function resumoDescartes(c) {
  const partes = [];
  for (const m of MOTIVOS) if (c[m]) partes.push(`${m}=${c[m]}`);
  return partes.join(" ") || "nenhum";
}

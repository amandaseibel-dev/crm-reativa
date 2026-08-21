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
import { isPnUser, isLidUser, jidDecode } from "baileys";

export const MOTIVOS = [
  "GRUPO",
  "BROADCAST",
  "CANAL",
  "SISTEMA",
  "LID_SEM_VINCULO",
  "TELEFONE_INVALIDO",
  "SEM_ID",
  "SEM_CONTEUDO",
  "INTERNO",
  // Chegou mensagem de gente e o WhatsApp não abriu o envelope. NÃO é o mesmo
  // que "sem conteúdo": ali é recibo, aqui é texto que existiu e não foi lido.
  "NAO_DECIFRADA",
  // Lote de `messages.upsert` que não é nem `notify` nem `append`.
  "LOTE_IGNORADO",
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
      if (isPnUser(c?.id) && this.registrar(c?.lid, c.id)) novos++;
    }
    for (const ch of chats || []) {
      if (this.registrar(ch?.lidJid, ch?.pnJid)) novos++;
      if (isLidUser(ch?.id) && this.registrar(ch.id, ch?.pnJid)) novos++;
      if (isPnUser(ch?.id) && this.registrar(ch?.lidJid, ch.id)) novos++;
    }
    return novos;
  }

  // Semeia a partir do `lid-mapping` que a PRÓPRIA CREDENCIAL guarda.
  //
  // POR QUE ISTO EXISTE — o pareamento do Comercial em 2026-08-20:
  //
  // `aprender()` só enxerga o que vem DENTRO dos lotes de histórico
  // (`chats`/`contacts`). No Baileys 7 o vínculo autoritativo não mora ali: o
  // WhatsApp entrega os pares LID↔telefone pelo canal do Signal, e a Baileys
  // os grava no store de chaves sob `lid-mapping`. Esse store é preenchido de
  // forma ASSÍNCRONA — no Comercial ele chegou a 1.805 pares, mas DEPOIS de o
  // sync ter fechado.
  //
  // Resultado: 39.455 mensagens de 899 contatos ficaram sem vínculo e não
  // entraram no CRM, embora o mapeamento dos 899 estivesse no disco minutos
  // depois. O histórico só é oferecido UMA VEZ por pareamento.
  //
  // A correção é ler o store ANTES de processar histórico. Não inventa vínculo
  // nenhum: usa o que a própria Baileys já persistiu.
  //
  // FORMATO (verificado na credencial real): as duas direções são gravadas, com
  // usuários crus, sem domínio.
  //   "5551999999999"            -> "179999999999999"   (telefone -> LID)
  //   "179999999999999_reverse"  -> "5551999999999"     (LID -> telefone)
  // Só a direção reversa é confiável para o nosso uso; a direta é aceita
  // invertendo-se, e `registrar()` valida o telefone dos dois jeitos.
  aprenderDoStore(chaves) {
    const mapa = chaves?.["lid-mapping"];
    if (!mapa || typeof mapa !== "object") return 0;

    const SUF = "_reverse";
    const soUsuario = (v) => String(v ?? "").split("@")[0];
    let novos = 0;

    for (const [bruto, valor] of Object.entries(mapa)) {
      const chave = String(bruto);
      let lid;
      let telefone;
      if (chave.endsWith(SUF)) {
        lid = soUsuario(chave.slice(0, -SUF.length));
        telefone = soUsuario(valor);
      } else {
        lid = soUsuario(valor);
        telefone = soUsuario(chave);
      }
      if (!lid || !telefone) continue;
      // Passa com domínio porque `registrar` usa `jidDecode`.
      if (this.registrar(`${lid}@lid`, `${telefone}@s.whatsapp.net`)) novos++;
    }
    return novos;
  }

  resolver(lidJid) {
    return this.porLid.get(this.#userDe(lidJid)) || null;
  }
}

// Formato do endereço, SEM os dígitos. Serve para o log dizer o que chegou sem
// despejar telefone de aluno no arquivo.
export function formatoDoJid(jid) {
  if (!jid) return "ausente";
  const t = String(jid);
  const arroba = t.indexOf("@");
  return arroba === -1 ? "sem-arroba" : t.slice(arroba);
}

// O telefone que o PRÓPRIO evento carrega. O Baileys decodifica `sender_pn` e
// `participant_pn` da mensagem e coloca na chave — é o telefone de quem
// escreveu, mesmo quando a conversa é endereçada por LID.
//
// Estávamos ignorando esse campo: por isso mensagem ao vivo de conta LID caía
// em LID_SEM_VINCULO e nunca chegava à Central, mesmo com o telefone ali.
// A Baileys 7 MUDOU ONDE O TELEFONE VEM, e isso custou mensagem perdida em
// produção em 19/08/2026: na 6.7.24 o telefone do remetente chegava em
// `senderPn`; na 7.x, numa conversa endereçada por LID, ele vem em
// `remoteJidAlt` (e `participantAlt` em grupo). Como este código só olhava os
// campos antigos, TODA mensagem de entrada caía em LID_SEM_VINCULO e era
// descartada — decodificada corretamente e jogada fora em seguida.
//
// Os campos antigos continuam sendo consultados primeiro: se a 7.x voltar a
// preenchê-los, ou se rodarmos a 6.7.24 de novo, nada muda.
//
// POR QUE O GUARDA `isPnUser` NOS CAMPOS `*Alt`: eles são "o outro endereço"
// da chave, não "o telefone". Numa conversa endereçada por PN, o `Alt` traz o
// LID — usar aquilo como telefone seria inventar um número que não existe. É a
// mesma armadilha do `0@s.whatsapp.net`: parece telefone, não é.
export function telefoneDaChave(chave) {
  // Campos da 6.7.24: por definição já são PN, ficam como estavam.
  for (const candidato of [chave?.senderPn, chave?.participantPn]) {
    if (!candidato) continue;
    const user = jidDecode(candidato)?.user;
    if (telefoneValido(user)) return { user, jid: candidato };
  }
  // Campos da 7.x: só valem se forem PN DE VERDADE.
  for (const candidato of [chave?.remoteJidAlt, chave?.participantAlt]) {
    if (!candidato || !isPnUser(candidato)) continue;
    const user = jidDecode(candidato)?.user;
    if (telefoneValido(user)) return { user, jid: candidato };
  }
  return null;
}

// O coração: devolve `{ telefone }` OU `{ motivo }`. Nunca as duas coisas, e
// nunca `null` silencioso — quem chama é obrigado a contabilizar o motivo.
//
// `chave` é a chave da mensagem (`msg.key`), quando houver: é dela que sai o
// telefone do remetente numa conversa endereçada por LID.
export function resolverEndereco(jid, vinculos, chave = null) {
  if (!jid) return { motivo: "SEM_ID" };

  const texto = String(jid);
  if (texto.endsWith("@g.us")) return { motivo: "GRUPO" };
  if (texto.endsWith("@broadcast")) return { motivo: "BROADCAST" };
  if (texto.endsWith("@newsletter")) return { motivo: "CANAL" };

  if (isLidUser(texto)) {
    const tel = vinculos?.resolver(texto);
    if (tel) return { telefone: tel, viaLid: true };

    // O evento pode trazer o telefone do remetente. Quando traz, aprendemos o
    // par para que as próximas mensagens deste LID resolvam pelo mapa, sem
    // depender de o campo vir de novo.
    const daChave = telefoneDaChave(chave);
    if (daChave) {
      vinculos?.registrar(texto, daChave.jid);
      return { telefone: daChave.user, viaLid: true };
    }

    return { motivo: "LID_SEM_VINCULO" };
  }

  if (isPnUser(texto)) {
    const user = jidDecode(texto)?.user || "";
    // `0@s.whatsapp.net` e afins passam por `isPnUser`, mas são o WhatsApp
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

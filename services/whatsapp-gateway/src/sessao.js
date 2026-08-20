// UMA sessão de WhatsApp. O serviço sobe duas destas, uma por número, e elas
// não compartilham nada além do processo: credencial, estado, QR, fila de
// reconexão e sincronização são todos por sessão.
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "baileys";
import QRCode from "qrcode";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { chamar, enviarMidia } from "./crm.js";

// Quem fala com o CRM. A indireção existe para o teste poder substituir sem
// rede. `tratarHistorico` é a função que já custou dois históricos: ela precisa
// ser exercitada DE VERDADE, com lotes reais, e isso exige esta costura.
let chamarCrm = chamar;
export function _usarCrmParaTeste(fn) {
  chamarCrm = fn || chamar;
}

// Costura de teste para o CICLO DE VIDA da conexão. Sem ela não há como provar
// a corrida de `conectar()` sem rede e sem WhatsApp — e foi uma corrida que
// derrubou a sessão 7 vezes em 8 horas, com o serviço brigando consigo mesmo.
let criarSocket = makeWASocket;
let obterVersao = fetchLatestBaileysVersion;
export function _usarSocketParaTeste(criar, versao) {
  criarSocket = criar || makeWASocket;
  obterVersao = versao || fetchLatestBaileysVersion;
}

// Eventos que uma sessão assina. Vira lista porque o ENCERRAMENTO precisa
// desfazer todos: socket antigo com manipulador vivo foi o que criou duas
// conexões concorrentes. Inclui os de ack de propósito — assim o encerramento
// continua completo quando a instrumentação estiver junta.
const EVENTOS_DA_SESSAO = [
  "creds.update", "contacts.upsert", "contacts.update", "chats.upsert",
  "messages.upsert", "messaging-history.set", "connection.update",
  "messages.update", "message-receipt.update",
];

// Desliga um socket SEM deixar que ele dispare mais nada.
//
// POR QUE REMOVER OS MANIPULADORES ANTES DO `end()`: encerrar faz o Baileys
// emitir `connection.update` com `close` no socket que está morrendo. Se o
// nosso manipulador ainda estiver ligado, ele lê isso como queda e agenda MAIS
// uma reconexão — exatamente a cascata que este código existe para acabar.
export function encerrarSocket(anterior) {
  if (!anterior) return false;
  try {
    for (const evento of EVENTOS_DA_SESSAO) anterior.ev?.removeAllListeners?.(evento);
  } catch { /* emissor já desligado */ }
  try {
    anterior.end?.(undefined);
  } catch { /* já encerrado */ }
  return true;
}
import { logSessao } from "./log.js";
import { enfileirar } from "./outbox.js";
import { baixarMidia, TIPOS_ACEITOS } from "./midia.js";
import {
  VinculosLid, criarContadores, formatoDoJid, resolverEndereco, resumoDescartes,
} from "./enderecos.js";
import { usarAuthStatePostgres } from "./authState.js";

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Quem entra na central e quem não entra vive em `enderecos.js`, com o motivo
// de cada descarte contado. O filtro antigo morava aqui e descartava todo
// `@lid` — foi o que jogou fora o histórico do primeiro pareamento.

// Extrai o que interessa da mensagem. Mídia na fase 1 é registrada como
// referência: o operador precisa SABER que veio um comprovante, mesmo que o
// arquivo em si só entre na fase 2.
function conteudo(msg) {
  const m = msg.message || {};
  const interno = m.ephemeralMessage?.message || m.viewOnceMessage?.message ||
                  m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m;

  if (interno.conversation) return { tipo: "text", texto: interno.conversation };
  if (interno.extendedTextMessage?.text) return { tipo: "text", texto: interno.extendedTextMessage.text };
  if (interno.imageMessage) return { tipo: "image", texto: interno.imageMessage.caption || null, mime: interno.imageMessage.mimetype };
  if (interno.videoMessage) return { tipo: "video", texto: interno.videoMessage.caption || null, mime: interno.videoMessage.mimetype };
  if (interno.audioMessage) return { tipo: interno.audioMessage.ptt ? "audio_voz" : "audio", texto: null, mime: interno.audioMessage.mimetype };
  if (interno.documentMessage) return { tipo: "document", texto: interno.documentMessage.fileName || null, mime: interno.documentMessage.mimetype };
  if (interno.stickerMessage) return { tipo: "sticker", texto: null, mime: interno.stickerMessage.mimetype };
  if (interno.locationMessage) return { tipo: "location", texto: null };
  if (interno.contactMessage) return { tipo: "contact", texto: interno.contactMessage.displayName || null };
  if (interno.reactionMessage) return { tipo: "reaction", texto: interno.reactionMessage.text || null };
  return { tipo: "outro", texto: null };
}

// Nomes do enum `proto.WebMessageInfo.Status` do Baileys, para o log ficar
// legível. Só instrumentação: o mapa para o nosso vocabulário de status é
// decidido depois, com base no que estes valores realmente forem em produção.
const NOME_DO_STATUS = {
  0: "ERROR",
  1: "PENDING",
  2: "SERVER_ACK",
  3: "DELIVERY_ACK",
  4: "READ",
  5: "PLAYED",
};

function paraISO(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  return new Date(n * 1000).toISOString();
}

// O que fazer quando a conexão cai. Função pura de propósito: esta decisão já
// custou uma credencial boa e 33 minutos do número fora do ar, e precisa ser
// testável sem socket, sem rede e sem WhatsApp.
//
// A DISTINÇÃO QUE IMPORTA — código explícito x padrão do Baileys:
//
//   O Baileys traduz `stream:error` em código assim (Utils/generics.js):
//       statusCode = +(node.attrs.code || CODE_MAP[reason] || badSession)
//
//   Ou seja: `badSession` (500) NÃO é o WhatsApp dizendo que a sessão morreu.
//   É o valor de ENCHIMENTO para qualquer stream:error que chegue sem o
//   atributo `code`. Em 19/08/2026 o WhatsApp mandou um `stream:error` cujo
//   único conteúdo era `<ack class="message" type="text">` — sem `code`. Virou
//   500 aqui dentro, o código tratou como credencial morta, apagou do disco E
//   do Postgres, e o número ficou pedindo QR até alguém parear de novo. A
//   credencial estava perfeita.
//
//   Já `loggedOut` (401) e `multideviceMismatch` (411) só existem quando o
//   WhatsApp manda o código explicitamente. Aí a credencial é inutilizável de
//   verdade e insistir com ela é reconectar para sempre contra uma sessão que
//   o outro lado já derrubou.
//
// POR QUE É SEGURO NÃO APAGAR NO 500: se a credencial estiver mesmo morta, a
// próxima tentativa de conexão volta com 401 explícito e o apagamento acontece
// ali, de forma legítima. O erro se corrige sozinho. O contrário — apagar por
// engano — é irreversível: reparear gasta a ÚNICA sincronização inicial de
// histórico daquele número.
export function politicaDeQueda(codigo) {
  // Invalidação inequívoca: o WhatsApp mandou o código, não o Baileys deduziu.
  if (codigo === DisconnectReason.loggedOut) {
    return { acao: "APAGAR_E_PAREAR", texto: "a sessao foi encerrada no celular - e preciso ler o QR de novo" };
  }
  if (codigo === DisconnectReason.multideviceMismatch) {
    return { acao: "APAGAR_E_PAREAR", texto: "o aparelho nao esta em multi-dispositivo - e preciso ler o QR de novo" };
  }

  // Passo NORMAL logo depois de ler o QR: o WhatsApp manda fechar e reabrir. A
  // reconexão precisa ser imediata, porque é na conexão SEGUINTE que o
  // histórico do aparelho chega — e ele vem uma vez só.
  if (codigo === DisconnectReason.restartRequired) {
    return { acao: "REINICIAR", texto: "reiniciando apos pareamento", atrasoMs: 500 };
  }

  // Outro aparelho assumiu esta sessão. Reconectar aqui vira cabo de guerra:
  // os dois lados se derrubam em looping. Para e avisa.
  if (codigo === DisconnectReason.connectionReplaced) {
    return {
      acao: "PARAR",
      texto: "outro dispositivo assumiu esta sessao - desconecte o WhatsApp Web e reconecte pela Central",
    };
  }

  // Todo o resto — inclusive `badSession` (500), `connectionLost` (408) e
  // `connectionClosed` (428) — é queda comum: preserva a credencial e tenta de
  // novo com o backoff normal.
  return { acao: "RECONECTAR" };
}

export function criarSessao({ chave }) {
  const log = logSessao(chave);

  let sock = null;
  let auth = null;
  let estadoAtual = "DESCONECTADO";
  let detalhe = null;
  let qrDataUrl = null;
  let tentativas = 0;
  let parando = false;
  let reconectando = false;
  // Reentrância de `conectar()`: sem isto, duas chamadas concorrentes criavam
  // DOIS sockets e o WhatsApp derrubava um com 440 connectionReplaced.
  let conectando = false;

  // Sincronização inicial: uma execução, vários lotes, e um relógio de
  // inatividade — o WhatsApp não avisa de forma confiável que terminou.
  let syncId = null;
  // Vínculo LID -> telefone aprendido com o próprio histórico e com os
  // contatos. Vive enquanto a sessão viver; é o que permite processar `@lid`
  // em vez de descartar.
  const vinculos = new VinculosLid();
  // Descartes contados POR MOTIVO. O silêncio foi o que deixou 5.800 mensagens
  // sumirem sem ninguém notar.
  const descartes = criarContadores();
  // Mensagem endereçada por LID cujo vínculo ainda não chegou. O WhatsApp não
  // garante que o contato venha ANTES da mensagem, e o histórico só vem uma
  // vez: descartar na hora seria repetir o erro que custou o primeiro
  // pareamento. Fica retida e é reavaliada quando a sincronização fecha.
  const retidasPorLid = [];
  let syncRelogio = null;

  async function reportar(status, { texto = null, ttlQr = null, jid = null } = {}) {
    estadoAtual = status;
    detalhe = texto;
    try {
      await chamarCrm("conexao", {
        sessao: chave,
        status,
        detalhe: texto,
        qr_code: status === "AGUARDANDO_QR" ? qrDataUrl : null,
        qr_ttl_seg: ttlQr,
        jid,
      });
    } catch {
      // Reportar estado é informativo. Se o CRM não atende agora, o próximo
      // heartbeat corrige — não vale derrubar a sessão por causa disso.
    }
  }

  // ---------------------------------------------------------------------
  // Sincronização inicial do histórico
  //
  // ESTA É A PARTE DE UMA CHANCE SÓ. O WhatsApp entrega o histórico do
  // aparelho apenas no momento do pareamento, e o pedido posterior de "manda o
  // resto" é ignorado para dispositivo vinculado. O que não for gravado aqui
  // não volta — por isso tudo vai para a fila em disco antes de qualquer coisa.
  // ---------------------------------------------------------------------
  async function garantirSync() {
    if (syncId) return syncId;
    try {
      syncId = await chamarCrm("sync.abrir", { sessao: chave });
      log.info({ syncId }, "sincronizacao inicial aberta");
    } catch (erro) {
      log.error({ erro: String(erro?.message || erro) }, "nao consegui abrir a sincronizacao");
    }
    return syncId;
  }

  function adiarFechamentoDoSync() {
    if (syncRelogio) clearTimeout(syncRelogio);
    syncRelogio = setTimeout(fecharSync, config.syncInatividadeSeg * 1000);
  }

  async function fecharSync() {
    if (!syncId) return;
    const id = syncId;
    syncId = null;
    if (syncRelogio) {
      clearTimeout(syncRelogio);
      syncRelogio = null;
    }
    // ÚLTIMA CHANCE das mensagens retidas: o vínculo LID->telefone pode ter
    // chegado num lote posterior ao da mensagem. Só agora, com tudo recebido,
    // dá para saber o que realmente não tem como ser resolvido.
    const aindaSemVinculo = [];
    let recuperadas = 0;
    for (const { jid, msg } of retidasPorLid) {
      const r = resolverEndereco(jid, vinculos, msg.key);
      if (r.telefone) {
        enfileirar("mensagem", mensagemDoHistorico(msg, r.telefone, null));
        descartes.aceitos++;
        descartes.resolvidos_por_lid++;
        recuperadas++;
      } else {
        aindaSemVinculo.push({ jid, wamid: msg.key?.id, em: paraISO(msg.messageTimestamp) });
        descartes.LID_SEM_VINCULO++;
      }
    }
    retidasPorLid.length = 0;

    // O que sobrou NÃO É APAGADO EM SILÊNCIO. Vai para disco com o LID, para
    // poder ser reprocessado se o vínculo aparecer depois. Perda silenciosa foi
    // o que fez 5.800 mensagens sumirem sem ninguém notar.
    if (aindaSemVinculo.length) {
      try {
        const arq = join(config.dadosDir, `lid-sem-vinculo-${chave}-${Date.now()}.json`);
        writeFileSync(arq, JSON.stringify(aindaSemVinculo, null, 2));
        log.error({ quantidade: aindaSemVinculo.length, arquivo: arq },
          "mensagens do historico sem vinculo LID->telefone - registradas em disco, nao descartadas");
      } catch (erro) {
        log.error({ erro: String(erro?.message || erro), quantidade: aindaSemVinculo.length },
          "nao consegui registrar as mensagens sem vinculo");
      }
    }

    enfileirar("sync.concluir", { sync_id: id });
    log.info(
      { syncId: id, recuperadasNoFim: recuperadas, semVinculo: aindaSemVinculo.length,
        aceitas: descartes.aceitos, porMotivo: resumoDescartes(descartes),
        vinculosLid: vinculos.tamanho },
      "sincronizacao inicial encerrada",
    );
  }

  // ---------------------------------------------------------------------
  // ANEXO — corre POR FORA da fila ordenada, de propósito.
  //
  // A mensagem de texto já foi enfileirada antes disto começar. Se o anexo
  // demorar ou falhar, nada segura as mensagens seguintes: o pior caso é a
  // conversa aparecer com o aviso de que o arquivo não pôde ser trazido.
  //
  // A mídia pode chegar ao servidor ANTES de a mensagem ter sido gravada no
  // banco (são caminhos independentes). Por isso a Edge Function devolve
  // `registrado: false` nesse caso e nós tentamos de novo, com espera.
  // ---------------------------------------------------------------------
  async function cuidarDoAnexo(msg, tipo) {
    if (!TIPOS_ACEITOS.has(tipo)) return;
    const wamid = msg.key?.id;
    if (!wamid) return;

    const r = await baixarMidia(msg);

    if (r.erro) {
      log.warn({ wamid, motivo: r.erro }, "anexo nao pode ser baixado");
      try {
        await enviarMidia({ wamid, erro: r.erro });
      } catch (erro) {
        log.error({ wamid, erro: String(erro?.message || erro) },
          "nao consegui registrar a falha do anexo");
      }
      return;
    }

    // Só metadado no log. Conteúdo binário nunca.
    log.info({ wamid, mime: r.mime, bytes: r.dados.length }, "anexo baixado");

    for (let tentativa = 1; tentativa <= 4; tentativa++) {
      try {
        const resposta = await enviarMidia({
          wamid,
          conteudo_base64: r.dados.toString("base64"),
          mime: r.mime,
          nome: r.nome,
        });
        if (resposta?.registrado) {
          log.info({ wamid, path: resposta.path }, "anexo guardado e associado a mensagem");
          return;
        }
        // Guardado, mas a mensagem ainda não estava no banco. Espera e insiste
        // só no registro — o arquivo já está no bucket.
        log.warn({ wamid, tentativa }, "anexo guardado, mensagem ainda nao gravada - vou insistir");
        await espera(2000 * tentativa);
      } catch (erro) {
        log.error({ wamid, tentativa, erro: String(erro?.message || erro) },
          "falha ao enviar o anexo ao CRM");
        if (tentativa === 4) return;
        await espera(2000 * tentativa);
      }
    }
  }

  // Monta o evento de uma mensagem do histórico. Existe separado porque as
  // mensagens retidas por LID são enfileiradas mais tarde, quando o vínculo
  // aparece — e precisam sair exatamente iguais às demais.
  function mensagemDoHistorico(msg, telefone, nome) {
    const { tipo, texto, mime } = conteudo(msg);
    return {
      sessao: chave,
      telefone,
      nome_perfil: nome || msg.pushName || null,
      wamid: msg.key.id,
      // fromMe = respondemos pelo celular antes do CRM existir. Entra como
      // SAIDA para o cálculo de "quem ficou sem retorno" ficar certo.
      direcao: msg.key.fromMe ? "SAIDA" : "ENTRADA",
      tipo,
      texto,
      midia_id: mime ? msg.key.id : null,
      midia_mime: mime || null,
      timestamp: paraISO(msg.messageTimestamp),
      origem: "SYNC_INICIAL",
      status: msg.key.fromMe ? "ENVIADO" : null,
    };
  }

  function tratarHistorico({ chats, contacts, messages, isLatest, syncType, progress }) {
    const lista = messages || [];

    // PRIMEIRO aprender os vínculos LID->telefone que vêm neste lote: sem
    // isso, as mensagens do próprio lote não teriam como ser resolvidas.
    //
    // E antes do log, não depois: instrumentar o log com uma variável ainda não
    // declarada derrubou o processamento de TODO o histórico do segundo
    // pareamento — erro de execução, que nem `node --check` nem teste de
    // função auxiliar pegam. Só teste que roda esta função inteira pega.
    const novosVinculos = vinculos.aprender({ chats, contacts });

    log.info(
      {
        conversas: chats?.length || 0,
        contatos: contacts?.length || 0,
        mensagens: lista.length,
        isLatest: Boolean(isLatest),
        syncType,
        progresso: progress,
        vinculosLid: vinculos.tamanho,
        novosVinculos,
      },
      "lote de historico recebido",
    );

    // Nome de perfil: indexado pelo TELEFONE já resolvido, para valer também
    // quando o contato chega endereçado por LID.
    const nomes = new Map();
    const anotarNome = (jid, nome) => {
      if (!nome) return;
      const r = resolverEndereco(jid, vinculos);
      if (r.telefone && !nomes.has(r.telefone)) nomes.set(r.telefone, nome);
    };
    for (const c of contacts || []) {
      anotarNome(c.jid || c.id, c.name || c.notify || c.verifiedName);
      anotarNome(c.lid, c.name || c.notify || c.verifiedName);
    }
    for (const c of chats || []) anotarNome(c.pnJid || c.id, c.name);

    let gravadas = 0;
    for (const msg of lista) {
      const jid = msg.key?.remoteJid;
      if (!msg.key?.id) { descartes.SEM_ID++; continue; }

      const endereco = resolverEndereco(jid, vinculos, msg.key);
      if (!endereco.telefone) {
        if (endereco.motivo === "LID_SEM_VINCULO") {
          retidasPorLid.push({ jid, msg });
        } else {
          descartes[endereco.motivo]++;
        }
        continue;
      }

      const telefone = endereco.telefone;
      descartes.aceitos++;
      if (endereco.viaLid) descartes.resolvidos_por_lid++;

      enfileirar("mensagem", mensagemDoHistorico(msg, telefone, nomes.get(telefone)));
      gravadas++;
    }

    log.info(
      { aproveitadas: gravadas, descartadas: lista.length - gravadas,
        porMotivo: resumoDescartes(descartes), resolvidosPorLid: descartes.resolvidos_por_lid,
        vinculosLid: vinculos.tamanho },
      "lote de historico processado",
    );

    if (syncId) {
      enfileirar("sync.contabilizar", {
        sync_id: syncId,
        conversas: chats?.length || 0,
        mensagens: gravadas,
        contatos: contacts?.length || 0,
        lote_final: Boolean(isLatest),
      });
    }

    adiarFechamentoDoSync();
  }

  function tratarMensagensNovas({ messages, type }) {
    // `notify` = chegou agora. `append` costuma ser preenchimento de histórico
    // durante a sincronização, e já é tratado pelo evento próprio.
    if (type !== "notify") return;

    for (const msg of messages || []) {
      const jid = msg.key?.remoteJid;
      if (!msg.key?.id) { descartes.SEM_ID++; continue; }
      if (!msg.message) { descartes.SEM_CONTEUDO++; continue; } // protocolo/recibo

      // Só FORMATO, nunca os dígitos: o log não pode virar depósito de telefone
      // de aluno. Isto existe porque uma mensagem real foi descartada e não
      // havia como saber qual campo tinha chegado preenchido.
      log.info(
        {
          remoteJid: formatoDoJid(msg.key.remoteJid),
          senderLid: formatoDoJid(msg.key.senderLid),
          senderPn: formatoDoJid(msg.key.senderPn),
          participantLid: formatoDoJid(msg.key.participantLid),
          participantPn: formatoDoJid(msg.key.participantPn),
        },
        "chave da mensagem recebida",
      );

      const endereco = resolverEndereco(jid, vinculos, msg.key);
      if (!endereco.telefone) {
        descartes[endereco.motivo]++;
        // TUDO o que der para saber sobre o descarte, MENOS conteúdo. Sem isto
        // a investigação vira dedução: o log dizia que a mensagem caiu, e não
        // dava para comparar a descartada com as que passaram.
        //
        // O id do LID entra de propósito: é o identificador ANÔNIMO que o
        // WhatsApp usa justamente para não expor telefone, e sem ele não dá
        // para saber se descartes repetidos são do mesmo contato.
        log.warn(
          {
            motivo: endereco.motivo,
            porMotivo: resumoDescartes(descartes),
            lid: String(jid || "").split("@")[0],
            formatos: {
              remoteJid: formatoDoJid(msg.key.remoteJid),
              senderLid: formatoDoJid(msg.key.senderLid),
              senderPn: formatoDoJid(msg.key.senderPn),
              participant: formatoDoJid(msg.key.participant),
              participantLid: formatoDoJid(msg.key.participantLid),
              participantPn: formatoDoJid(msg.key.participantPn),
            },
            // estrutura da mensagem, nunca o texto
            tiposDeConteudo: Object.keys(msg.message || {}).slice(0, 6),
            stubType: msg.messageStubType ?? null,
            fromMe: Boolean(msg.key.fromMe),
            temPushName: Boolean(msg.pushName),
            broadcast: Boolean(msg.broadcast),
            vinculosConhecidos: vinculos.tamanho,
          },
          "mensagem recebida sem telefone utilizavel - nao enfileirada",
        );
        continue;
      }
      descartes.aceitos++;
      if (endereco.viaLid) descartes.resolvidos_por_lid++;

      const { tipo, texto, mime } = conteudo(msg);

      enfileirar("mensagem", {
        sessao: chave,
        telefone: endereco.telefone,
        nome_perfil: msg.pushName || null,
        wamid: msg.key.id,
        // Mensagem enviada do CELULAR pelo operador também é registrada, senão
        // a conversa some da fila de "sem retorno" só na cabeça de quem
        // respondeu, e o CRM continuaria mostrando que ninguém respondeu.
        direcao: msg.key.fromMe ? "SAIDA" : "ENTRADA",
        tipo,
        texto,
        midia_id: mime ? msg.key.id : null,
        midia_mime: mime || null,
        timestamp: paraISO(msg.messageTimestamp),
        origem: "TEMPO_REAL",
        status: msg.key.fromMe ? "ENVIADO" : null,
      });

      // Dispara o download SEM esperar: a fila de mensagens não pode ficar
      // presa atrás de um anexo lento. Erros são tratados lá dentro.
      if (mime) {
        cuidarDoAnexo(msg, tipo).catch((erro) =>
          log.error({ erro: String(erro?.message || erro) }, "anexo: falha inesperada"));
      }
    }
  }

  // ---------------------------------------------------------------------
  // Ciclo de vida da conexão
  // ---------------------------------------------------------------------
  async function conectar() {
    if (parando) return;

    // GUARDA DE REENTRÂNCIA. Em 20/08/2026 o serviço abriu duas conexões
    // simultâneas e uma derrubou a outra: 7 `connectionReplaced` (440) em 8
    // horas, com "connected to WA" e "logging in..." saindo em duplicata no
    // log. Não era outro aparelho — era ele contra ele mesmo.
    if (conectando) {
      log.warn("conexao ja em andamento - pedido ignorado");
      return;
    }
    conectando = true;

    try {
      // O socket velho sai de cena ANTES de o novo nascer. Antes disto,
      // `sock = makeWASocket(...)` apenas trocava a referência e deixava o
      // anterior VIVO, ainda falando com o WhatsApp.
      encerrarSocket(sock);
      sock = null;

      auth = auth || (await usarAuthStatePostgres(chave));
      const { version } = await obterVersao();

      await reportar("CONECTANDO", { texto: `protocolo ${version.join(".")}` });

      sock = criarSocket({
      version,
      auth: {
        creds: auth.state.creds,
        // Cache das chaves de assinatura: sem ele, cada mensagem recebida vira
        // uma rodada de leituras e a sessão engasga em volume.
        keys: makeCacheableSignalKeyStore(auth.state.keys, log),
      },
      // O nome que aparece em "Aparelhos conectados" no celular. Ser
      // reconhecível importa: alguém pode desconectar por engano o que não
      // souber identificar.
      browser: ["ReATIVA One", "Chrome", "1.0.0"],
      printQRInTerminal: false,
      // Não marca a empresa como "online": o celular continua recebendo
      // notificação normalmente, e o espelho não rouba a presença de quem
      // ainda atende pelo aparelho.
      markOnlineOnConnect: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      generateHighQualityLinkPreview: false,
      logger: log,
    });

    sock.ev.on("creds.update", () => auth.salvarCredenciais());

    // -------------------------------------------------------------------
    // INSTRUMENTAÇÃO DE ACK — fase 1: SÓ OBSERVA.
    //
    // Hoje o status de saída é gravado uma vez, no momento em que a mensagem
    // entra na fila, e nunca mais muda. "ENVIADO" na Central significa apenas
    // "nós enfileiramos" — o operador lê isso como "o aluno recebeu", e não é.
    //
    // Antes de trocar o modelo de status em produção, é preciso PROVAR quais
    // valores esta sessão realmente entrega. O mapa do enum do Baileys
    // (PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5) é o que a
    // biblioteca promete; o que o WhatsApp de fato manda para ESTE número, com
    // ESTE aparelho, é o que estas duas linhas vão registrar.
    //
    // Correlação exclusivamente por `wamid` (`key.id`), como pedido: é a única
    // chave estável entre o envio e o ack.
    //
    // Número de telefone NUNCA vai para o log: só o formato do JID, igual ao
    // resto do serviço.
    // -------------------------------------------------------------------
    sock.ev.on("messages.update", (atualizacoes) => {
      for (const u of atualizacoes || []) {
        if (!u?.key?.fromMe) continue; // ack só interessa no que NÓS mandamos
        log.info(
          {
            ack: "messages.update",
            wamid: u.key.id,
            destino: formatoDoJid(u.key.remoteJid),
            statusBruto: u.update?.status ?? null,
            statusNome: NOME_DO_STATUS[u.update?.status] ?? null,
            camposDoUpdate: Object.keys(u.update || {}),
          },
          "ack observado",
        );
      }
    });

    sock.ev.on("message-receipt.update", (recibos) => {
      for (const r of recibos || []) {
        if (!r?.key?.fromMe) continue;
        log.info(
          {
            ack: "message-receipt.update",
            wamid: r.key.id,
            destino: formatoDoJid(r.key.remoteJid),
            recibo: formatoDoJid(r.receipt?.userJid),
            entregueEm: r.receipt?.receiptTimestamp ?? null,
            lidoEm: r.receipt?.readTimestamp ?? null,
            tocadoEm: r.receipt?.playedTimestamp ?? null,
          },
          "recibo observado",
        );
      }
    });

    // Contatos que chegam fora do histórico também trazem o par LID/telefone.
    sock.ev.on("contacts.upsert", (c) => vinculos.aprender({ contacts: c }));
    sock.ev.on("contacts.update", (c) => vinculos.aprender({ contacts: c }));
    sock.ev.on("chats.upsert", (c) => vinculos.aprender({ chats: c }));
    sock.ev.on("messages.upsert", tratarMensagensNovas);
    sock.ev.on("messaging-history.set", async (dados) => {
      await garantirSync();
      tratarHistorico(dados);
    });

    sock.ev.on("connection.update", async (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });

        // CHEGAR AO QR JÁ É SUCESSO — e por isso zera o contador de tentativas.
        //
        // POR QUE ISTO É NECESSÁRIO: o contador só era zerado em
        // `connection === "open"`, que o Baileys emite apenas DEPOIS do login.
        // Numa sessão ainda não pareada esse evento nunca chega, então cada
        // expiração normal da janela do QR (que fecha com `connectionLost`)
        // era contada como falha e a espera dobrava: 2s, 4s, 8s... até o teto
        // de 5 minutos. Resultado prático: quem fosse parear abria a Central e
        // encontrava QR vencido, tendo que esperar minutos por um novo.
        //
        // Receber o QR prova que o socket subiu e o handshake funcionou. Isso
        // não é falha: é a sessão esperando gente. O backoff exponencial
        // continua valendo para queda de verdade, antes de chegar ao QR.
        tentativas = 0;
        // O WhatsApp troca o QR a cada ~20s; o CRM precisa saber que o que
        // está na tela venceu, em vez de mostrar um código morto.
        await reportar("AGUARDANDO_QR", { texto: "leia o QR Code no celular", ttlQr: 60 });
        log.warn("QR Code novo disponivel para pareamento");
      }

      if (connection === "open") {
        // O próprio número da empresa: aqui o JID é sempre de telefone.
        await tratarConexaoAberta(sock.user?.id ? String(sock.user.id).split("@")[0].split(":")[0] : null);
      }

      if (connection === "close") {
        // QR guardado em memória morre junto com a conexão. Sem isto o /saude
        // dizia `temQr: true` com a sessão caída — informação que não ajuda
        // quem está diagnosticando.
        qrDataUrl = null;
        await tratarQueda(lastDisconnect?.error?.output?.statusCode);
      }
    });

      // SÓ AGORA a trava de reconexão cai — com o socket novo já de pé.
      //
      // Antes ela caía na PRIMEIRA linha de `conectar()`, ou seja, antes de
      // `usarAuthStatePostgres` e `fetchLatestBaileysVersion`, dois acessos de
      // rede. Naquela janela `agendarReconexao` se considerava livre e uma
      // segunda conexão entrava — a corrida que gerava os 440.
      reconectando = false;
    } finally {
      conectando = false;
    }
  }

  async function tratarConexaoAberta(jid) {
    tentativas = 0;
    qrDataUrl = null;
    await reportar("CONECTADO", { texto: null, jid });
    log.info({ jid }, "sessao conectada");
  }

  // Executa a decisão de `politicaDeQueda`. Separado do manipulador de evento
  // para que o teste possa exercitar a queda inteira — inclusive o apagamento
  // da credencial, que é a parte irreversível — sem subir socket nenhum.
  async function tratarQueda(codigo) {
    const motivo = Object.keys(DisconnectReason).find((k) => DisconnectReason[k] === codigo) || codigo;
    log.warn({ codigo, motivo }, "conexao caiu");

    // Histórico interrompido no meio: fecha a execução para o CRM não ficar
    // com uma sincronização eternamente "em andamento".
    await fecharSync();

    const politica = politicaDeQueda(codigo);

    if (politica.acao === "APAGAR_E_PAREAR") {
      log.warn({ codigo, motivo }, "invalidacao explicita do WhatsApp - apagando credencial");
      await auth.apagar();
      auth = null;
      await reportar("PAREAMENTO_NECESSARIO", { texto: politica.texto });
      agendarReconexao(5_000);
      return;
    }

    if (politica.acao === "REINICIAR") {
      log.info("reinicio pedido pelo WhatsApp (normal apos pareamento)");
      await reportar("CONECTANDO", { texto: politica.texto });
      agendarReconexao(politica.atrasoMs);
      return;
    }

    if (politica.acao === "PARAR") {
      await reportar("ERRO", { texto: politica.texto });
      return;
    }

    // RECONECTAR: a credencial fica onde está, no disco e no Postgres.
    await reportar("DESCONECTADO", { texto: `queda (${motivo})` });
    agendarReconexao();
  }

  // Costura de teste. Sem ela, exercitar uma queda dispara um `conectar()` de
  // verdade por `setTimeout`: rede, socket e um laço de reconexão que não
  // termina junto com o teste. Registrar o pedido também é o que prova que a
  // sessão TENTOU voltar, em vez de desistir com a credencial na mão.
  let reconexaoDeTeste = null;

  function agendarReconexao(forcarMs = null) {
    if (reconexaoDeTeste) {
      reconexaoDeTeste(forcarMs);
      return;
    }
    if (parando || reconectando) return;
    reconectando = true;

    const atraso = forcarMs ?? Math.min(config.backoffInicialMs * 2 ** tentativas, config.backoffMaximoMs);
    tentativas++;
    log.info({ atrasoMs: atraso, tentativa: tentativas }, "reconexao agendada");

    setTimeout(() => {
      conectar().catch(async (erro) => {
        log.error({ erro: String(erro?.message || erro) }, "falha ao reconectar");
        reconectando = false;
        agendarReconexao();
      });
    }, atraso);
  }

  return {
    chave,
    iniciar: () => conectar(),
    // Costura de teste. Estes manipuladores são internos de propósito, mas
    // `tratarHistorico` perdeu o histórico de DOIS pareamentos — uma vez por um
    // filtro errado, outra por um erro de execução que nenhum teste de função
    // auxiliar pegaria. Só executando esta função inteira dá para provar que
    // ela funciona.
    _paraTeste: {
      tratarHistorico: (lote) => tratarHistorico(lote),
      tratarMensagensNovas: (lote) => tratarMensagensNovas(lote),
      fecharSync: () => fecharSync(),
      garantirSync: () => garantirSync(),
      descartes: () => ({ ...descartes }),
      vinculos: () => vinculos,
      // A queda pelo caminho de verdade: mesma função que o evento do Baileys
      // chama. É o único jeito de provar que um 500 NÃO apaga a credencial.
      tratarQueda: (codigo) => tratarQueda(codigo),
      conexaoAberta: ({ jid } = {}) => tratarConexaoAberta(jid ?? null),
      usarAuth: (a) => { auth = a; },
      auth: () => auth,
      usarReconexao: (fn) => { reconexaoDeTeste = fn; },
    },
    estado: () => ({
      sessao: chave,
      status: estadoAtual,
      detalhe,
      temQr: Boolean(qrDataUrl),
      conectado: estadoAtual === "CONECTADO",
      // Visível no /saude de propósito: descarte silencioso foi o que fez o
      // histórico do primeiro pareamento sumir sem ninguém perceber.
      vinculos_lid: vinculos.tamanho,
      descartes: resumoDescartes(descartes),
      aceitas: descartes.aceitos,
      resolvidas_por_lid: descartes.resolvidos_por_lid,
      // Aguardando o vínculo aparecer num lote posterior. É o número que diz se
      // vale continuar o pareamento ou parar: retenção alta significa que o
      // vínculo não está vindo, e processar mais seria queimar a chance à toa.
      retidas_por_lid: retidasPorLid.length,
      sincronizando: Boolean(syncId),
      tentativasReconexao: tentativas,
    }),
    // Batimento: o CRM só confia em "CONECTADO" se este sinal continuar
    // chegando. Processo morto nunca reporta que morreu.
    baterCoracao: () => reportar(estadoAtual, { texto: detalhe }),

    enviarTexto: async (telefone, texto) => {
      if (estadoAtual !== "CONECTADO" || !sock) {
        throw new Error(`sessao ${chave} nao esta conectada (${estadoAtual})`);
      }
      const jid = `${String(telefone).replace(/\D/g, "")}@s.whatsapp.net`;
      const enviada = await sock.sendMessage(jid, { text: texto });
      return { wamid: enviada?.key?.id || null };
    },

    desconectar: async () => {
      parando = true;
      try {
        await sock?.end(undefined);
      } catch { /* ja estava fechado */ }
      await reportar("DESCONECTADO", { texto: "desconectado pela gestao" });
      parando = false;
    },

    reconectar: async () => {
      tentativas = 0;
      try {
        await sock?.end(undefined);
      } catch { /* ja estava fechado */ }
      reconectando = false;
      await conectar();
    },

    // Logout REAL: desvincula o aparelho e joga fora a credencial. Depois
    // disto só volta com QR novo — e a sincronização inicial já foi gasta.
    sair: async () => {
      try {
        await sock?.logout();
      } catch { /* pode ja estar fora */ }
      await auth?.apagar();
      auth = null;
      await reportar("PAREAMENTO_NECESSARIO", { texto: "desvinculado pela gestao" });
      agendarReconexao(3_000);
    },

    encerrar: async () => {
      parando = true;
      if (syncRelogio) clearTimeout(syncRelogio);
      try {
        await sock?.end(undefined);
      } catch { /* ja estava fechado */ }
      await auth?.descarregar();
    },
  };
}

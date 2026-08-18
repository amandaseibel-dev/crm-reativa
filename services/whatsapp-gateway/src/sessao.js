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
import { config } from "./config.js";
import { chamar } from "./crm.js";
import { logSessao } from "./log.js";
import { enfileirar } from "./outbox.js";
import { usarAuthStatePostgres } from "./authState.js";

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Quem NÃO entra na central. Escopo desta fase é receptivo 1:1.
function jidIgnorado(jid) {
  if (!jid) return true;
  return (
    jid.endsWith("@g.us") ||            // grupo
    jid.endsWith("@broadcast") ||       // listas e status
    jid.endsWith("@newsletter") ||      // canais
    jid.includes("@lid")                // id anônimo: não dá para saber o telefone
  );
}

function telefoneDoJid(jid) {
  return String(jid || "").split("@")[0].split(":")[0];
}

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

function paraISO(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  return new Date(n * 1000).toISOString();
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

  // Sincronização inicial: uma execução, vários lotes, e um relógio de
  // inatividade — o WhatsApp não avisa de forma confiável que terminou.
  let syncId = null;
  let syncRelogio = null;

  async function reportar(status, { texto = null, ttlQr = null, jid = null } = {}) {
    estadoAtual = status;
    detalhe = texto;
    try {
      await chamar("conexao", {
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
      syncId = await chamar("sync.abrir", { sessao: chave });
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
    enfileirar("sync.concluir", { sync_id: id });
    log.info({ syncId: id }, "sincronizacao inicial encerrada");
  }

  function tratarHistorico({ chats, contacts, messages, isLatest, syncType, progress }) {
    const lista = messages || [];
    log.info(
      {
        conversas: chats?.length || 0,
        contatos: contacts?.length || 0,
        mensagens: lista.length,
        isLatest: Boolean(isLatest),
        syncType,
        progresso: progress,
      },
      "lote de historico recebido",
    );

    // Nome de perfil vindo dos contatos: melhora a identificação de quem é.
    const nomes = new Map();
    for (const c of contacts || []) {
      const tel = telefoneDoJid(c.id);
      const nome = c.name || c.notify || c.verifiedName;
      if (tel && nome) nomes.set(tel, nome);
    }
    for (const c of chats || []) {
      const tel = telefoneDoJid(c.id);
      if (tel && c.name && !nomes.has(tel)) nomes.set(tel, c.name);
    }

    let gravadas = 0;
    for (const msg of lista) {
      const jid = msg.key?.remoteJid;
      if (jidIgnorado(jid) || !msg.key?.id) continue;

      const { tipo, texto, mime } = conteudo(msg);
      const telefone = telefoneDoJid(jid);

      enfileirar("mensagem", {
        sessao: chave,
        telefone,
        nome_perfil: nomes.get(telefone) || msg.pushName || null,
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
      });
      gravadas++;
    }

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
      if (jidIgnorado(jid) || !msg.key?.id) continue;
      if (!msg.message) continue; // protocolo/recibo, não é mensagem de gente

      const { tipo, texto, mime } = conteudo(msg);

      enfileirar("mensagem", {
        sessao: chave,
        telefone: telefoneDoJid(jid),
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
    }
  }

  // ---------------------------------------------------------------------
  // Ciclo de vida da conexão
  // ---------------------------------------------------------------------
  async function conectar() {
    if (parando) return;
    reconectando = false;

    auth = auth || (await usarAuthStatePostgres(chave));
    const { version } = await fetchLatestBaileysVersion();

    await reportar("CONECTANDO", { texto: `protocolo ${version.join(".")}` });

    sock = makeWASocket({
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
    sock.ev.on("messages.upsert", tratarMensagensNovas);
    sock.ev.on("messaging-history.set", async (dados) => {
      await garantirSync();
      tratarHistorico(dados);
    });

    sock.ev.on("connection.update", async (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        // O WhatsApp troca o QR a cada ~20s; o CRM precisa saber que o que
        // está na tela venceu, em vez de mostrar um código morto.
        await reportar("AGUARDANDO_QR", { texto: "leia o QR Code no celular", ttlQr: 60 });
        log.warn("QR Code novo disponivel para pareamento");
      }

      if (connection === "open") {
        tentativas = 0;
        qrDataUrl = null;
        const jid = sock.user?.id ? telefoneDoJid(sock.user.id) : null;
        await reportar("CONECTADO", { texto: null, jid });
        log.info({ jid }, "sessao conectada");
      }

      if (connection === "close") {
        const codigo = lastDisconnect?.error?.output?.statusCode;
        const motivo = Object.keys(DisconnectReason).find((k) => DisconnectReason[k] === codigo) || codigo;
        log.warn({ codigo, motivo }, "conexao caiu");

        // Histórico interrompido no meio: fecha a execução para o CRM não
        // ficar com uma sincronização eternamente "em andamento".
        await fecharSync();

        const precisaNovoQr =
          codigo === DisconnectReason.loggedOut ||
          codigo === DisconnectReason.badSession ||
          codigo === DisconnectReason.multideviceMismatch;

        if (precisaNovoQr) {
          // A credencial morreu. Insistir com ela é reconectar para sempre
          // contra uma sessão que o WhatsApp já derrubou.
          await auth.apagar();
          auth = null;
          await reportar("PAREAMENTO_NECESSARIO", {
            texto: "a sessao foi encerrada no celular - e preciso ler o QR de novo",
          });
          agendarReconexao(5_000);
          return;
        }

        if (codigo === DisconnectReason.restartRequired) {
          // Passo NORMAL logo depois de ler o QR: o WhatsApp manda fechar e
          // reabrir. A reconexão precisa ser imediata, porque é na conexão
          // SEGUINTE que o histórico do aparelho chega — e ele vem uma vez só.
          log.info("reinicio pedido pelo WhatsApp (normal apos pareamento)");
          await reportar("CONECTANDO", { texto: "reiniciando apos pareamento" });
          agendarReconexao(500);
          return;
        }

        if (codigo === DisconnectReason.connectionReplaced) {
          // Outro aparelho assumiu esta sessão. Reconectar aqui vira cabo de
          // guerra: os dois lados se derrubam em looping. Para e avisa.
          await reportar("ERRO", {
            texto: "outro dispositivo assumiu esta sessao - desconecte o WhatsApp Web e reconecte pela Central",
          });
          return;
        }

        await reportar("DESCONECTADO", { texto: `queda (${motivo})` });
        agendarReconexao();
      }
    });
  }

  function agendarReconexao(forcarMs = null) {
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
    estado: () => ({
      sessao: chave,
      status: estadoAtual,
      detalhe,
      temQr: Boolean(qrDataUrl),
      conectado: estadoAtual === "CONECTADO",
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

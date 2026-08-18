// Log estruturado. Cada linha é JSON com a sessão embutida — sem isso, com dois
// números no mesmo processo, não se descobre qual deles caiu.
import pino from "pino";

export const log = pino({
  level: process.env.LOG_NIVEL || "info",
  base: { servico: "whatsapp-gateway" },
  // Nunca logar conteúdo de mensagem: é dado pessoal de aluno (LGPD). O que
  // interessa no log é o QUE aconteceu, não o que a pessoa escreveu.
  redact: {
    paths: ["texto", "*.texto", "payload", "*.payload", "qr", "*.qr"],
    censor: "[oculto]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const logSessao = (chave) => log.child({ sessao: chave });

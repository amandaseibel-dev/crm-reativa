// Fala com o CRM — e é o ÚNICO arquivo que fala.
//
// O espelho não tem credencial de banco. Ele conversa com uma Edge Function do
// Supabase, assinando cada requisição com HMAC-SHA256 de um segredo
// compartilhado. Consequência: invadir esta máquina não dá acesso ao CRM; dá
// acesso a mandar evento de WhatsApp, e só.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { log } from "./log.js";

const CAMINHO = "/whatsapp-webhook";
const CAMINHO_MIDIA = "/whatsapp-midia";

function assinar(corpo, timestamp) {
  return createHmac("sha256", config.crmSegredo)
    .update(`${timestamp}.${corpo}`)
    .digest("hex");
}

// Confere o token que as Edge Functions usam para mandar comando NESTE serviço.
// Comparação em tempo constante: a diferença de tempo entre dois tokens
// vazaria informação sobre o segredo.
export function tokenDeComandoConfere(recebido) {
  const a = Buffer.from(String(recebido || ""), "utf8");
  const b = Buffer.from(config.gatewayToken, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Envia o arquivo já baixado para a Edge Function que grava no bucket.
 *
 * SEPARADO de `chamar` de propósito: é outra Edge Function, o corpo é grande
 * (binário em base64) e o timeout precisa ser maior. Misturar isso com a fila
 * de mensagens faria um anexo pesado atrasar texto de aluno.
 */
export async function enviarMidia(dados, { tentativas = 3 } = {}) {
  const corpo = JSON.stringify(dados);
  let ultimoErro;

  for (let i = 0; i < tentativas; i++) {
    try {
      const ts = Date.now().toString();
      const resposta = await fetch(config.crmUrl + CAMINHO_MIDIA, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gateway-timestamp": ts,
          "x-gateway-assinatura": assinar(corpo, ts),
        },
        body: corpo,
        signal: AbortSignal.timeout(90_000),
      });
      const texto = await resposta.text();
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}: ${texto.slice(0, 200)}`);
      return texto ? JSON.parse(texto) : null;
    } catch (erro) {
      ultimoErro = erro;
      if (String(erro.message).includes("HTTP 4")) break;
      if (i < tentativas - 1) await espera(2000 * 2 ** i);
    }
  }
  throw ultimoErro;
}

/**
 * Chamada com resposta. Usada para o que o serviço PRECISA saber agora:
 * ler credencial da sessão, gravar credencial, reportar conexão.
 * Tenta algumas vezes com espera crescente antes de desistir.
 */
export async function chamar(acao, dados, { tentativas = 4 } = {}) {
  const corpo = JSON.stringify({ acao, dados });
  let ultimoErro;

  for (let i = 0; i < tentativas; i++) {
    try {
      const ts = Date.now().toString();
      const resposta = await fetch(config.crmUrl + CAMINHO, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gateway-timestamp": ts,
          "x-gateway-assinatura": assinar(corpo, ts),
        },
        body: corpo,
        signal: AbortSignal.timeout(20_000),
      });

      const texto = await resposta.text();
      if (!resposta.ok) {
        throw new Error(`HTTP ${resposta.status}: ${texto.slice(0, 300)}`);
      }
      return texto ? JSON.parse(texto) : null;
    } catch (erro) {
      ultimoErro = erro;
      // 4xx de assinatura ou ação inválida não melhora com repetição.
      if (String(erro.message).includes("HTTP 4")) break;
      if (i < tentativas - 1) await espera(config.backoffInicialMs * 2 ** i);
    }
  }

  log.error({ acao, erro: String(ultimoErro?.message || ultimoErro) }, "falha ao falar com o CRM");
  throw ultimoErro;
}

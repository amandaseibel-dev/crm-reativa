// Validação do áudio que o operador grava na Central.
//
// Mesmo desenho do `pdf.ts`: lógica pura, sem rede e sem Supabase, para o
// vitest da raiz exercitar exatamente o código que a Edge Function importa.
//
// A REGRA CENTRAL é a mesma do PDF: quem decide o tipo são os BYTES. O
// `blob.type` vem do navegador e é texto que qualquer um escreve.
//
// LISTA FECHADA: só os dois formatos que o gravador do navegador produz —
// OGG (Firefox) e WebM (Chrome/Edge). Qualquer outro formato é decisão nova.

// 1 MB. É o teto do corpo na API de controle do gateway
// (services/whatsapp-gateway/src/audio.js). Dois minutos de voz a 32 kbps
// ocupam cerca de 480 KB, então sobra folga sem abrir espaço para arquivo
// grande entrar por este caminho.
export const LIMITE_AUDIO_BYTES = 1_000_000;

// O que fica guardado e o que o aluno recebe é sempre OGG: o gateway converte.
export const MIME_GUARDADO = "audio/ogg";

export type FormatoAudio = "ogg" | "webm";

export function formatoDoAudio(dados: Uint8Array): FormatoAudio | null {
  if (dados.length < 4) return null;
  // "OggS"
  if (dados[0] === 0x4f && dados[1] === 0x67 && dados[2] === 0x67 && dados[3] === 0x53) {
    return "ogg";
  }
  // EBML — cabeçalho de todo WebM.
  if (dados[0] === 0x1a && dados[1] === 0x45 && dados[2] === 0xdf && dados[3] === 0xa3) {
    return "webm";
  }
  return null;
}

export type Recusa = { ok: false; erro: string };
export type Aprovacao = { ok: true; formato: FormatoAudio; tamanho: number };

// Um portão só. A mensagem é a que o operador lê.
export function validarAudio(dados: Uint8Array): Recusa | Aprovacao {
  if (dados.length === 0) return { ok: false, erro: "a gravação está vazia" };

  if (dados.length > LIMITE_AUDIO_BYTES) {
    const kb = Math.round(dados.length / 1000);
    return {
      ok: false,
      erro: `áudio de ${kb} KB — o limite é ${LIMITE_AUDIO_BYTES / 1000} KB (cerca de 2 minutos)`,
    };
  }

  const formato = formatoDoAudio(dados);
  if (!formato) {
    return { ok: false, erro: "o arquivo não é uma gravação de áudio" };
  }

  return { ok: true, formato, tamanho: dados.length };
}

// Caminho imprevisível no bucket, no mesmo padrão do PDF de saída.
export function caminhoNovoAudio(aleatorio: string): string {
  const agora = new Date();
  const ano = agora.getUTCFullYear();
  const mes = String(agora.getUTCMonth() + 1).padStart(2, "0");
  return `saida/${ano}/${mes}/${aleatorio}.ogg`;
}

// base64 → bytes, para o OGG que o gateway devolve. Devolve null se o texto não
// for base64: a mensagem já saiu, e uma cópia corrompida não pode ser guardada
// como se fosse o áudio.
export function bytesDeBase64(texto: string): Uint8Array | null {
  try {
    const bruto = atob(String(texto || ""));
    const bytes = new Uint8Array(bruto.length);
    for (let i = 0; i < bruto.length; i++) bytes[i] = bruto.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

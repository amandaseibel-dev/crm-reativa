// Baixar a mídia que o aluno mandou.
//
// POR QUE ISTO EXISTE: até aqui o operador via "[image]" e nada mais. Numa
// operação de cobrança, o anexo quase sempre É a mensagem — o comprovante. Sem
// ele, a Central mostra que algo chegou e obriga a pessoa a abrir o celular.
//
// TRÊS REGRAS QUE NÃO PODEM SER AFROUXADAS:
//
//   1. O TAMANHO É CONFERIDO ANTES DE SAIR DAQUI. Um arquivo grande demais não
//      pode virar um POST de 40 MB para a Edge Function.
//
//   2. O TIPO É DECIDIDO PELOS BYTES. O `mimetype` que vem na mensagem é texto
//      que o remetente escolhe; a assinatura do arquivo, não. A Edge Function
//      confere de novo do lado dela — dois portões, de propósito.
//
//   3. FALHA AQUI NUNCA SEGURA MENSAGEM. A mensagem de texto já foi para a fila
//      ordenada antes disto rodar. Se o download falhar, registra-se o motivo e
//      a conversa segue; o operador vê que veio anexo e que não deu para trazer.
import { downloadMediaMessage } from "baileys";

// Abaixo do limite da Edge Function (16 MB) para o base64 não estourar o corpo:
// base64 cresce ~33%, então 10 MB de arquivo viram ~13,4 MB de texto.
export const LIMITE_BYTES = 10 * 1024 * 1024;

// Só o que a Central sabe exibir nesta fase. Vídeo fica de fora por decisão.
export const TIPOS_ACEITOS = new Set(["image", "document", "audio", "audio_voz"]);

const ASSINATURAS = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp", bytes: [0x57, 0x45, 0x42, 0x50], deslocamento: 8 },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: "audio/ogg", bytes: [0x4f, 0x67, 0x67, 0x53] },
  { mime: "audio/mpeg", bytes: [0x49, 0x44, 0x33] },
  { mime: "audio/mpeg", bytes: [0xff, 0xfb] },
  { mime: "audio/amr", bytes: [0x23, 0x21, 0x41, 0x4d, 0x52] },
  { mime: "audio/wav", bytes: [0x57, 0x41, 0x56, 0x45], deslocamento: 8 },
  { mime: "audio/mp4", bytes: [0x66, 0x74, 0x79, 0x70], deslocamento: 4 },
];

/** MIME pela assinatura do arquivo. `null` quando não reconhece. */
export function mimeReal(dados) {
  if (!dados || dados.length < 4) return null;
  for (const a of ASSINATURAS) {
    const off = a.deslocamento ?? 0;
    if (dados.length < off + a.bytes.length) continue;
    let bate = true;
    for (let i = 0; i < a.bytes.length; i++) {
      if (dados[off + i] !== a.bytes[i]) { bate = false; break; }
    }
    if (bate) return a.mime;
  }
  return null;
}

/** O nome original do documento, quando houver. Nunca o caminho do remetente. */
export function nomeDoDocumento(msg) {
  const m = msg?.message || {};
  const interno = m.documentWithCaptionMessage?.message || m;
  const nome = interno?.documentMessage?.fileName;
  if (!nome) return null;
  // Só o nome do arquivo: `../` e barras não entram em metadado nosso.
  return String(nome).split(/[\\/]/).pop().slice(0, 200);
}

/**
 * Baixa e valida. Devolve `{ dados, mime, nome }` ou `{ erro }`.
 * NUNCA lança: quem chama está num caminho que não pode derrubar a sessão.
 */
export async function baixarMidia(msg, { limite = LIMITE_BYTES, baixar = downloadMediaMessage } = {}) {
  try {
    const dados = await baixar(msg, "buffer", {});
    if (!dados || dados.length === 0) return { erro: "anexo veio vazio" };

    if (dados.length > limite) {
      return {
        erro: `anexo acima do limite (${(dados.length / 1024 / 1024).toFixed(1)} MB)`,
      };
    }

    const mime = mimeReal(dados);
    if (!mime) return { erro: "tipo de arquivo nao suportado nesta fase" };

    return { dados, mime, nome: nomeDoDocumento(msg) };
  } catch (erro) {
    // Mídia do WhatsApp expira. Isso não é defeito nosso, e o operador precisa
    // saber a diferença entre "não deu para trazer" e "não veio nada".
    return { erro: `nao foi possivel baixar: ${String(erro?.message || erro).slice(0, 160)}` };
  }
}

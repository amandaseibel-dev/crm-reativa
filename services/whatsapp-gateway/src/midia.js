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

// ---------------------------------------------------------------------------
// FORMATOS QUE COMPARTILHAM CONTAINER
//
// docx e xlsx são ZIP; doc e xls antigos são OLE2. Os primeiros bytes não
// distinguem um do outro — e confiar na extensão seria abrir a porta que este
// arquivo existe para fechar.
//
// A saída é olhar DENTRO: num .docx existe a entrada `word/document.xml`, num
// .xlsx existe `xl/workbook.xml`, e os nomes aparecem em texto puro no cabeçalho
// local de cada arquivo do ZIP. Nos OLE2 antigos os nomes de fluxo (`WordDocument`,
// `Workbook`) aparecem em UTF-16 no diretório.
// ---------------------------------------------------------------------------
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function comeca(dados, bytes, off = 0) {
  if (dados.length < off + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (dados[off + i] !== bytes[i]) return false;
  return true;
}

function contem(dados, texto, limite = 8192) {
  return dados.subarray(0, limite).includes(Buffer.from(texto, "latin1"));
}

function contemUtf16(dados, texto, limite = 8192) {
  const alvo = Buffer.from(texto.split("").join("\u0000") + "\u0000", "latin1");
  return dados.subarray(0, limite).includes(alvo);
}

// Texto não tem assinatura. O que dá para afirmar é que NÃO é binário: sem
// bytes nulos e decodificável como UTF-8. É o critério honesto disponível.
function pareceTexto(dados) {
  const amostra = dados.subarray(0, 4096);
  for (const b of amostra) {
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(amostra);
    return true;
  } catch {
    return false;
  }
}

/** Documentos que precisam olhar além dos primeiros bytes. */
function mimeDeDocumento(dados, nome = "") {
  const ext = String(nome || "").toLowerCase().split(".").pop();

  if (comeca(dados, ZIP)) {
    if (contem(dados, "word/")) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if (contem(dados, "xl/")) {
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }
    return null; // ZIP de outra coisa: não entra nesta fase
  }

  if (comeca(dados, OLE2)) {
    if (contemUtf16(dados, "WordDocument")) return "application/msword";
    if (contemUtf16(dados, "Workbook") || contemUtf16(dados, "Book")) return "application/vnd.ms-excel";
    return null;
  }

  if (pareceTexto(dados)) {
    return ext === "csv" ? "text/csv" : "text/plain";
  }

  return null;
}

/** MIME pela assinatura do arquivo. `null` quando não reconhece. */
export function mimeReal(dados, nome = "") {
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
  return mimeDeDocumento(dados, nome);
}

// A extensão declarada BATE com o que os bytes dizem?
//
// Não é para adivinhar o tipo — isso já foi feito pelos bytes. É para recusar
// o caso em que alguém renomeia um arquivo para passar por outro: `.pdf` que na
// verdade é ZIP, `.docx` que é imagem. Extensão desconhecida não bloqueia.
const EXTENSAO_ESPERADA = {
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  csv: ["text/csv", "text/plain"],
  txt: ["text/plain", "text/csv"],
  jpg: ["image/jpeg"], jpeg: ["image/jpeg"], png: ["image/png"],
  gif: ["image/gif"], webp: ["image/webp"],
};

export function extensaoConfere(nome, mime) {
  const ext = String(nome || "").toLowerCase().split(".").pop();
  const esperados = EXTENSAO_ESPERADA[ext];
  if (!esperados) return true; // extensão que não conhecemos não é motivo para recusar
  return esperados.includes(mime);
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

    const nome = nomeDoDocumento(msg);
    const mime = mimeReal(dados, nome);
    if (!mime) return { erro: "tipo de arquivo nao suportado nesta fase" };

    // Extensão que promete uma coisa e conteúdo que é outra: recusa. Não é
    // sobre adivinhar o tipo — isso os bytes já disseram — é sobre não deixar
    // passar arquivo renomeado para enganar.
    if (!extensaoConfere(nome, mime)) {
      return { erro: `extensao nao corresponde ao conteudo (${mime})` };
    }

    return { dados, mime, nome };
  } catch (erro) {
    // Mídia do WhatsApp expira. Isso não é defeito nosso, e o operador precisa
    // saber a diferença entre "não deu para trazer" e "não veio nada".
    return { erro: `nao foi possivel baixar: ${String(erro?.message || erro).slice(0, 160)}` };
  }
}

// Junta os documentos de UM aluno num PDF único, dentro do navegador.
// ---------------------------------------------------------------------------
// Existe porque o termo, o RG e o verso são três arquivos separados no Storage
// e a operação precisa deles como um documento só — para imprimir, mandar às
// testemunhas ou arquivar. Antes disso era abrir três abas e juntar na mão.
//
// A junção acontece no cliente: as URLs assinadas já vêm da Edge Function
// `documento-financeiro-url`, que valida a permissão por registro. Aqui nada é
// baixado do Storage direto nem persistido — as URLs assinadas não são
// guardadas e o PDF montado só existe na memória até o download.
//
// PDF entra como páginas nativas; JPG e PNG viram uma página A4 (deitada quando
// a imagem é mais larga que alta). Word e HEIC não têm como ser convertidos no
// navegador: entram na lista de `falhas` e o chamador avisa — nunca somem em
// silêncio, senão o PDF sai incompleto sem ninguém perceber.
//
// O pdf-lib é carregado por import dinâmico: são ~1 MB que só a tela de termos
// usa e não têm por que pesar no bundle de todo mundo.

const A4 = [595.28, 841.89];

function ehPdf(b) {
  return b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
}

function ehPng(b) {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

function ehJpg(b) {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
}

// Formato lido pelos bytes, não pela extensão: arquivo enviado como ".pdf" que
// na verdade é foto acontece, e o nome mente.
export function formatoDe(bytes) {
  if (!bytes || bytes.length === 0) return "vazio";
  if (ehPdf(bytes)) return "pdf";
  if (ehPng(bytes)) return "png";
  if (ehJpg(bytes)) return "jpg";
  return "desconhecido";
}

/**
 * @param {Array<{rotulo: string, bytes: Uint8Array}>} pecas na ordem final
 * @returns {Promise<{bytes: Uint8Array|null, paginas: number, incluidas: string[], falhas: Array<{rotulo: string, motivo: string}>}>}
 */
export async function juntarEmPdf(pecas) {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const falhas = [];
  const incluidas = [];

  for (const peca of pecas || []) {
    const bytes = peca?.bytes;
    const rotulo = peca?.rotulo || "Documento";
    const formato = formatoDe(bytes);

    if (formato === "vazio" || formato === "desconhecido") {
      falhas.push({
        rotulo,
        motivo: formato === "vazio" ? "arquivo vazio" : "formato não suportado (Word/HEIC entram só convertidos)",
      });
      continue;
    }

    try {
      if (formato === "pdf") {
        const origem = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const paginas = await doc.copyPages(origem, origem.getPageIndices());
        paginas.forEach((pg) => doc.addPage(pg));
      } else {
        const img = formato === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        // Deita a página quando a imagem é mais larga que alta: RG fotografado
        // na horizontal ficaria minúsculo espremido no meio de um A4 em pé.
        const paisagem = img.width > img.height;
        const [largura, altura] = paisagem ? [A4[1], A4[0]] : A4;
        const pg = doc.addPage([largura, altura]);
        const escala = Math.min((largura - 40) / img.width, (altura - 40) / img.height);
        const w = img.width * escala;
        const h = img.height * escala;
        pg.drawImage(img, { x: (largura - w) / 2, y: (altura - h) / 2, width: w, height: h });
      }
      incluidas.push(rotulo);
    } catch {
      falhas.push({ rotulo, motivo: "arquivo corrompido ou ilegível" });
    }
  }

  if (doc.getPageCount() === 0) {
    return { bytes: null, paginas: 0, incluidas, falhas };
  }
  return { bytes: await doc.save(), paginas: doc.getPageCount(), incluidas, falhas };
}

// Nome do arquivo baixado. Sem acento e sem barra: o Finder e o Windows tratam
// isso de formas diferentes e o download sai quebrado num deles.
export function nomeArquivoPdf(alunoNome) {
  const base = String(alunoNome || "aluno")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return `Termo - ${base || "aluno"}.pdf`;
}

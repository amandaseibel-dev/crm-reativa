import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { juntarEmPdf, formatoDe, nomeArquivoPdf } from "./juntarPdf";

async function pdfDePaginas(n, largura = 300, altura = 400) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([largura, altura]);
  return doc.save();
}

// PNG 2x1 válido, menor que dá para escrever inline.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP8z8Dwn4GBgQEAEwsCA/nMfXwAAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);

describe("formatoDe", () => {
  it("le o formato pelos bytes, nao pela extensao", async () => {
    expect(formatoDe(await pdfDePaginas(1))).toBe("pdf");
    expect(formatoDe(PNG)).toBe("png");
    expect(formatoDe(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(formatoDe(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBe("desconhecido"); // .docx
    expect(formatoDe(new Uint8Array(0))).toBe("vazio");
    expect(formatoDe(null)).toBe("vazio");
  });
});

describe("juntarEmPdf", () => {
  it("junta PDFs preservando todas as paginas, na ordem recebida", async () => {
    const res = await juntarEmPdf([
      { rotulo: "Termo", bytes: await pdfDePaginas(3) },
      { rotulo: "RG", bytes: await pdfDePaginas(2) },
    ]);
    expect(res.paginas).toBe(5);
    expect(res.incluidas).toEqual(["Termo", "RG"]);
    expect(res.falhas).toEqual([]);
    expect(formatoDe(res.bytes)).toBe("pdf");
  });

  it("transforma imagem em uma pagina", async () => {
    const res = await juntarEmPdf([
      { rotulo: "Termo", bytes: await pdfDePaginas(1) },
      { rotulo: "RG", bytes: PNG },
    ]);
    expect(res.paginas).toBe(2);
    expect(res.incluidas).toEqual(["Termo", "RG"]);
  });

  it("deita a pagina quando a imagem e mais larga que alta", async () => {
    const res = await juntarEmPdf([{ rotulo: "RG", bytes: PNG }]); // 2x1 = paisagem
    const doc = await PDFDocument.load(res.bytes);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
  });

  // O ponto que importa: arquivo que nao entrou nunca some calado, senao o PDF
  // sai incompleto e ninguem percebe.
  it("nao engole formato nao suportado: reporta em falhas e segue com o resto", async () => {
    const res = await juntarEmPdf([
      { rotulo: "Termo", bytes: await pdfDePaginas(2) },
      { rotulo: "RG", bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]) }, // Word
    ]);
    expect(res.paginas).toBe(2);
    expect(res.incluidas).toEqual(["Termo"]);
    expect(res.falhas).toHaveLength(1);
    expect(res.falhas[0].rotulo).toBe("RG");
  });

  it("reporta arquivo corrompido sem derrubar a juncao", async () => {
    const quebrado = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x99, 0x99]);
    const res = await juntarEmPdf([
      { rotulo: "Termo", bytes: quebrado },
      { rotulo: "RG", bytes: await pdfDePaginas(1) },
    ]);
    expect(res.paginas).toBe(1);
    expect(res.incluidas).toEqual(["RG"]);
    expect(res.falhas.map((f) => f.rotulo)).toEqual(["Termo"]);
  });

  it("devolve bytes nulos quando nada pode ser juntado", async () => {
    const res = await juntarEmPdf([{ rotulo: "Termo", bytes: new Uint8Array(0) }]);
    expect(res.bytes).toBeNull();
    expect(res.paginas).toBe(0);
    expect(res.falhas).toHaveLength(1);
  });

  it("aceita lista vazia sem quebrar", async () => {
    const res = await juntarEmPdf([]);
    expect(res.bytes).toBeNull();
    expect(res.paginas).toBe(0);
  });
});

describe("nomeArquivoPdf", () => {
  it("tira acento e caractere que quebra download", () => {
    expect(nomeArquivoPdf("Alice Costa Corrêa")).toBe("Termo - Alice Costa Correa.pdf");
    expect(nomeArquivoPdf("Ana / Maria")).toBe("Termo - Ana Maria.pdf");
    expect(nomeArquivoPdf("")).toBe("Termo - aluno.pdf");
    expect(nomeArquivoPdf(null)).toBe("Termo - aluno.pdf");
  });
});

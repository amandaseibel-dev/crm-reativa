// Portão de entrada do anexo. Se algum destes testes cair, o que passa a
// atravessar não é "um arquivo estranho": é um arquivo escolhido por quem
// quisesse enganar a validação.
import { describe, it, expect } from "vitest";
import { LIMITE_BYTES, LIMITE_NOME, ehPdf, nomeSeguro, validarPdf, caminhoNovo } from "./pdf.ts";

// PDF mínimo de verdade: assinatura + um corpo qualquer.
function pdf(bytesExtra = 32) {
  const cabecalho = new TextEncoder().encode("%PDF-1.7\n");
  const total = new Uint8Array(cabecalho.length + bytesExtra);
  total.set(cabecalho, 0);
  total.fill(0x20, cabecalho.length);
  return total;
}

describe("validarPdf — 1. PDF válido pequeno", () => {
  it("passa e devolve nome, mime e tamanho", () => {
    const dados = pdf();
    const r = validarPdf("boleto.pdf", dados);
    expect(r).toEqual({
      ok: true,
      nome: "boleto.pdf",
      mime: "application/pdf",
      tamanho: dados.length,
    });
  });

  it("aceita extensão em maiúscula — .PDF é PDF", () => {
    expect(validarPdf("BOLETO.PDF", pdf()).ok).toBe(true);
  });
});

describe("validarPdf — 2. nome longo", () => {
  it("encurta sem perder a ponta que distingue o arquivo", () => {
    const miolo = "acordo-de-renegociacao-" + "x".repeat(300);
    const r = validarPdf(`${miolo}-parcela-12.pdf`, pdf());
    expect(r.ok).toBe(true);
    // continua .pdf, cabe no limite, e o final — que é o que identifica —
    // sobreviveu
    expect(r.nome.endsWith(".pdf")).toBe(true);
    expect(r.nome.length).toBeLessThanOrEqual(LIMITE_NOME + 4);
    expect(r.nome).toContain("parcela-12");
    expect(r.nome.startsWith("acordo-de-renegociacao")).toBe(true);
  });

  it("nome com caminho não vira caminho: só o arquivo sobra", () => {
    expect(nomeSeguro("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(nomeSeguro("C:\\temp\\boleto.pdf")).toBe("boleto.pdf");
  });

  it("caractere de controle no nome é removido", () => {
    expect(nomeSeguro("bo\u0000le\u001fto.pdf")).toBe("boleto.pdf");
  });

  it("nome que sobra vazio ganha um nome, em vez de virar '.pdf'", () => {
    expect(nomeSeguro("")).toBe("documento.pdf");
    expect(nomeSeguro(".pdf")).toBe("documento.pdf");
    expect(nomeSeguro("../")).toBe("documento.pdf");
  });
});

describe("validarPdf — 3. extensão falsa", () => {
  it("executável renomeado para .pdf é recusado pelos BYTES", () => {
    // MZ: cabeçalho de executável do Windows.
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    const r = validarPdf("boleto.pdf", exe);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/não é um PDF de verdade/);
  });

  it("ELF (executável Linux) renomeado também não passa", () => {
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    expect(validarPdf("contrato.pdf", elf).ok).toBe(false);
  });

  it("ZIP disfarçado de PDF não passa", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(validarPdf("planilha.pdf", zip).ok).toBe(false);
  });

  it("'%PDF' no MEIO do arquivo não vale — a assinatura é no começo", () => {
    const enganoso = new Uint8Array(64);
    enganoso.set(new TextEncoder().encode("%PDF-1.4"), 10);
    expect(ehPdf(enganoso)).toBe(false);
  });

  it("PDF de verdade com extensão de outro formato é recusado por ser outro formato", () => {
    const r = validarPdf("documento.docx", pdf());
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/só PDF/);
  });

  it("arquivo vazio não passa", () => {
    expect(validarPdf("vazio.pdf", new Uint8Array(0)).ok).toBe(false);
  });

  it("arquivo curto demais para ter assinatura não passa", () => {
    expect(validarPdf("curto.pdf", new Uint8Array([0x25, 0x50])).ok).toBe(false);
  });
});

describe("validarPdf — 4. acima do limite", () => {
  it("recusa e diz o tamanho e o teto, em MB", () => {
    // Um byte além do limite: a fronteira exata é onde erro de comparação mora.
    const grande = new Uint8Array(LIMITE_BYTES + 1);
    grande.set(new TextEncoder().encode("%PDF-1.7"), 0);
    const r = validarPdf("enorme.pdf", grande);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/16 MB/);
  });

  it("exatamente no limite ainda passa", () => {
    const noLimite = new Uint8Array(LIMITE_BYTES);
    noLimite.set(new TextEncoder().encode("%PDF-1.7"), 0);
    expect(validarPdf("no-limite.pdf", noLimite).ok).toBe(true);
  });

  it("o limite é o mesmo da mídia de entrada e cabe no bucket", () => {
    expect(LIMITE_BYTES).toBe(16 * 1024 * 1024);
    expect(LIMITE_BYTES).toBeLessThan(20 * 1024 * 1024); // teto duro do bucket
  });
});

describe("caminho no bucket", () => {
  it("não usa o nome do arquivo — só ano, mês e o aleatório", () => {
    const caminho = caminhoNovo("a".repeat(32));
    expect(caminho).toMatch(/^saida\/\d{4}\/\d{2}\/a{32}\.pdf$/);
  });

  it("dois arquivos do mesmo nome não colidem", () => {
    expect(caminhoNovo("1".repeat(32))).not.toBe(caminhoNovo("2".repeat(32)));
  });
});

import { describe, it, expect } from "vitest";
import { hashArquivo } from "./hashArquivo";

// Bytes quaisquer, estáveis, representando "o arquivo".
const BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0xff, 0x01]);
// SHA-256 desses 10 bytes, obtido FORA do código sob teste — se o valor viesse
// da própria função, o teste seria tautológico e um bug na normalização passaria.
//   printf '\x50\x4b\x03\x04\x14\x00\x06\x00\xff\x01' | shasum -a 256
const ESPERADO = "705f624686a350d170bdbd8ad1b2319da7289fee24782f3f5eb63ba64cd62a9b";

describe("hashArquivo", () => {
  it("devolve 64 caracteres hex minúsculos", async () => {
    const h = await hashArquivo(BYTES.buffer);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  // O REQUISITO DO J3/I1: os dois importadores têm de produzir o MESMO hash
  // para o mesmo arquivo. ImportacaoAcordos recebe o ArrayBuffer do FileReader;
  // Borderos recebe o de File.arrayBuffer(). Se divergissem, a idempotência
  // entre os dois fluxos cairia em silêncio.
  it("mesmo arquivo, os dois fluxos: hash idêntico", async () => {
    const fluxoImportacaoAcordos = BYTES.buffer; // FileReader → ArrayBuffer
    const fluxoBorderos = BYTES.slice().buffer; // File.arrayBuffer() → ArrayBuffer
    const a = await hashArquivo(fluxoImportacaoAcordos);
    const b = await hashArquivo(fluxoBorderos);
    expect(a).toBe(b);
  });

  it("ArrayBuffer e Uint8Array dos mesmos bytes: hash idêntico", async () => {
    const a = await hashArquivo(BYTES.buffer);
    const b = await hashArquivo(BYTES);
    expect(a).toBe(b);
  });

  // Uint8Array pode ser uma JANELA de um buffer maior. Passar `.buffer` direto
  // hashearia o buffer inteiro e daria outro resultado — o bug que a
  // normalização dentro da função evita.
  it("view parcial de um buffer maior: hasheia só a view", async () => {
    const maior = new Uint8Array(64);
    maior.set(BYTES, 10);
    const janela = maior.subarray(10, 10 + BYTES.length);
    expect(janela.byteOffset).toBe(10);
    const a = await hashArquivo(janela);
    const b = await hashArquivo(BYTES);
    expect(a).toBe(b);
  });

  it("arquivos diferentes: hashes diferentes", async () => {
    const outro = new Uint8Array([...BYTES, 0x00]);
    expect(await hashArquivo(BYTES)).not.toBe(await hashArquivo(outro));
  });

  it("determinístico entre chamadas", async () => {
    expect(await hashArquivo(BYTES)).toBe(await hashArquivo(BYTES));
  });

  it("conteúdo ausente: recusa em vez de hashear vazio", async () => {
    await expect(hashArquivo(null)).rejects.toThrow(/conteúdo ausente/);
    await expect(hashArquivo(undefined)).rejects.toThrow(/conteúdo ausente/);
  });

  it("arquivo vazio tem hash, e é o do vazio", async () => {
    const h = await hashArquivo(new ArrayBuffer(0));
    // SHA-256 da string vazia
    expect(h).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("casa com o valor de referência dos bytes fixos", async () => {
    expect(await hashArquivo(BYTES)).toBe(ESPERADO);
  });
});

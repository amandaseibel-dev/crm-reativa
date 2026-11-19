// Portão de entrada do áudio gravado na Central. Mesmo papel do pdf.test.js:
// se cair, o que passa a atravessar é um arquivo escolhido para enganar.
import { describe, it, expect } from "vitest";
import {
  LIMITE_AUDIO_BYTES, MIME_GUARDADO, formatoDoAudio, validarAudio, caminhoNovoAudio, bytesDeBase64,
} from "./audio.ts";

function comCabecalho(cabecalho, extra = 64) {
  const total = new Uint8Array(cabecalho.length + extra);
  total.set(cabecalho, 0);
  total.fill(7, cabecalho.length);
  return total;
}
const ogg = (extra) => comCabecalho([0x4f, 0x67, 0x67, 0x53], extra);
const webm = (extra) => comCabecalho([0x1a, 0x45, 0xdf, 0xa3], extra);

describe("validarAudio", () => {
  it("aceita OGG (Firefox) e WebM (Chrome), decidindo pelos bytes", () => {
    expect(validarAudio(ogg())).toEqual({ ok: true, formato: "ogg", tamanho: 68 });
    expect(validarAudio(webm())).toEqual({ ok: true, formato: "webm", tamanho: 68 });
  });

  it("recusa gravação vazia", () => {
    expect(validarAudio(new Uint8Array(0))).toEqual({ ok: false, erro: "a gravação está vazia" });
  });

  it("recusa o que não é gravação, seja qual for o nome que veio do navegador", () => {
    const pdf = new TextEncoder().encode("%PDF-1.7 renomeado para audio.webm");
    const exe = new TextEncoder().encode("MZ executavel renomeado");
    expect(validarAudio(pdf).ok).toBe(false);
    expect(validarAudio(exe).ok).toBe(false);
    expect(formatoDoAudio(new Uint8Array([0x4f, 0x67]))).toBe(null);
  });

  it("recusa acima de 1 MB e aceita exatamente no teto", () => {
    expect(validarAudio(webm(LIMITE_AUDIO_BYTES - 4)).ok).toBe(true);
    const r = validarAudio(webm(LIMITE_AUDIO_BYTES - 3));
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/limite é 1000 KB/);
  });

  it("o teto é o mesmo 1 MB do gateway", () => {
    expect(LIMITE_AUDIO_BYTES).toBe(1_000_000);
  });
});

describe("guarda do áudio", () => {
  it("o caminho é aleatório, em saida/ano/mês, e sempre .ogg", () => {
    expect(caminhoNovoAudio("abc123")).toMatch(/^saida\/\d{4}\/\d{2}\/abc123\.ogg$/);
    expect(MIME_GUARDADO).toBe("audio/ogg");
  });

  it("base64 do gateway volta a ser os mesmos bytes", () => {
    const original = ogg(10);
    const texto = btoa(String.fromCharCode(...original));
    expect(Array.from(bytesDeBase64(texto))).toEqual(Array.from(original));
  });

  it("base64 inválido devolve null em vez de lixo", () => {
    expect(bytesDeBase64("isto não é base64 !!!")).toBe(null);
  });
});

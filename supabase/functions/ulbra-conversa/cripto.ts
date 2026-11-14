// ===========================================================================
// Cifra dos tokens do operador em repouso: AES-256-GCM com chave que fica FORA
// do banco (secret da Edge Function `ULBRA_TOKENS_CHAVE`, 64 hex = 32 bytes).
// Formato guardado: base64url(iv 12 bytes || texto cifrado || tag).
// Quem lê a tabela sem a chave não lê token nenhum.
// ===========================================================================

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function deB64u(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function chaveDeHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("CHAVE_INVALIDA");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function importar(chave: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", chave, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function cifrar(texto: string, chave: Uint8Array): Promise<string> {
  const k = await importar(chave);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const dados = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(texto));
  const junto = new Uint8Array(iv.length + dados.byteLength);
  junto.set(iv, 0);
  junto.set(new Uint8Array(dados), iv.length);
  return b64u(junto);
}

export async function decifrar(cifrado: string, chave: Uint8Array): Promise<string> {
  const junto = deB64u(cifrado);
  if (junto.length < 13) throw new Error("CIFRA_INVALIDA");
  const k = await importar(chave);
  const iv = junto.slice(0, 12);
  const dados = junto.slice(12);
  const aberto = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k, dados);
  return new TextDecoder().decode(aberto);
}

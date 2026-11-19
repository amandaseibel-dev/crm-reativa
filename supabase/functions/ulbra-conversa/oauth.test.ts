// OAuth individual: PKCE, URL de autorização, troca/renovação/revogação com fetch
// simulado e validação do retorno. Nenhuma requisição real.
import { describe, it, expect } from "vitest";
import {
  ENDPOINT_AUTH, ENDPOINT_REVOGACAO, ENDPOINT_TOKEN, ESCOPOS_MINIMOS, PEDIDO_VALIDADE_MS, RECURSO_MCP,
  gerarPkce, renovarToken, revogarToken, trocarCodigo, urlDeAutorizacao, validarRetorno,
} from "./oauth.ts";
import { chaveDeHex, cifrar, decifrar } from "./cripto.ts";

const AGORA = Date.parse("2026-11-11T15:00:00Z");

describe("PKCE e URL de autorização", () => {
  it("verifier de 86 chars base64url, challenge S256 de 43, state próprio; a URL leva tudo e o recurso MCP", async () => {
    const p = await gerarPkce();
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(p.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const url = new URL(urlDeAutorizacao({ clientId: "reativa", redirectUri: "https://crm-reativa.vercel.app/ulbra/conectado", challenge: p.challenge, state: p.state }));
    expect(url.origin + url.pathname).toBe(ENDPOINT_AUTH);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(p.challenge);
    expect(url.searchParams.get("state")).toBe(p.state);
    expect(url.searchParams.get("resource")).toBe(RECURSO_MCP);
    expect(url.searchParams.get("scope")).toBe(ESCOPOS_MINIMOS.join(" "));
    expect(url.searchParams.get("scope")).not.toMatch(/campanhas|equipes:write|atendimentos:fila/);
  });
  it("o challenge é determinístico para o mesmo verifier (S256)", async () => {
    const fixo = (n: number) => new Uint8Array(n).fill(7);
    const a = await gerarPkce(fixo);
    const b = await gerarPkce(fixo);
    expect(a.challenge).toBe(b.challenge);
    expect(a.verifier).toBe(b.verifier);
  });
});

function fetchSimulado(respostas: Record<string, { status: number; corpo: unknown }>, registro: Array<{ url: string; body: string }>) {
  return async (url: string, init: { body: string }) => {
    registro.push({ url, body: init.body });
    const r = respostas[url];
    if (!r) return { ok: false, status: 404, text: async () => "" };
    return { ok: r.status < 300, status: r.status, text: async () => (typeof r.corpo === "string" ? r.corpo : JSON.stringify(r.corpo)) };
  };
}

describe("troca, renovação e revogação (cliente público)", () => {
  it("troca o código com code_verifier e sem segredo; lê expires_in e refresh", async () => {
    const reg: Array<{ url: string; body: string }> = [];
    const f = fetchSimulado({ [ENDPOINT_TOKEN]: { status: 200, corpo: { access_token: "at1", refresh_token: "rt1", expires_in: 1800, scope: "mcp:acesso conversas:read mensagens:enviar" } } }, reg);
    const t = await trocarCodigo({ clientId: "reativa", redirectUri: "https://x/cb", code: "abc", verifier: "v".repeat(86) }, f, AGORA);
    expect(t).toEqual({ access_token: "at1", refresh_token: "rt1", expira_em_ms: AGORA + 1800_000, escopo: "mcp:acesso conversas:read mensagens:enviar" });
    const body = new URLSearchParams(reg[0].body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("v".repeat(86));
    expect(body.get("client_id")).toBe("reativa");
    expect(body.has("client_secret")).toBe(false);
    expect(body.get("resource")).toBe(RECURSO_MCP);
  });
  it("resposta sem access_token ou HTTP de erro vira exceção nomeada; sem expires_in assume 1 h", async () => {
    const reg: Array<{ url: string; body: string }> = [];
    await expect(trocarCodigo({ clientId: "r", redirectUri: "u", code: "c", verifier: "v" }, fetchSimulado({ [ENDPOINT_TOKEN]: { status: 400, corpo: { error: "invalid_grant" } } }, reg), AGORA)).rejects.toThrow("TOKEN_HTTP_400");
    await expect(trocarCodigo({ clientId: "r", redirectUri: "u", code: "c", verifier: "v" }, fetchSimulado({ [ENDPOINT_TOKEN]: { status: 200, corpo: { nada: 1 } } }, reg), AGORA)).rejects.toThrow("TOKEN_SEM_ACCESS_TOKEN");
    const t = await trocarCodigo({ clientId: "r", redirectUri: "u", code: "c", verifier: "v" }, fetchSimulado({ [ENDPOINT_TOKEN]: { status: 200, corpo: { access_token: "x" } } }, reg), AGORA);
    expect(t.expira_em_ms).toBe(AGORA + 3600_000);
    expect(t.refresh_token).toBeNull();
  });
  it("renova com grant refresh_token e revoga no endpoint de revogação", async () => {
    const reg: Array<{ url: string; body: string }> = [];
    const f = fetchSimulado({ [ENDPOINT_TOKEN]: { status: 200, corpo: { access_token: "at2", refresh_token: "rt2", expires_in: 60 } }, [ENDPOINT_REVOGACAO]: { status: 200, corpo: "" } }, reg);
    const t = await renovarToken({ clientId: "r", refreshToken: "rt1" }, f, AGORA);
    expect(t.access_token).toBe("at2");
    expect(new URLSearchParams(reg[0].body).get("grant_type")).toBe("refresh_token");
    await revogarToken({ clientId: "r", token: "rt2" }, f);
    expect(reg[1].url).toBe(ENDPOINT_REVOGACAO);
    expect(new URLSearchParams(reg[1].body).get("token")).toBe("rt2");
  });
});

describe("retorno do navegador", () => {
  const pend = { state: "s1", criado_em_ms: AGORA - 1000 };
  it("aceita só com o mesmo state, dentro da validade e com código", () => {
    expect(validarRetorno({ code: "c", state: "s1" }, pend, AGORA)).toEqual({ ok: true, code: "c" });
    expect(validarRetorno({ code: "c", state: "s2" }, pend, AGORA)).toEqual({ ok: false, motivo: "STATE_DIFERENTE" });
    expect(validarRetorno({ code: "c", state: "s1" }, null, AGORA)).toEqual({ ok: false, motivo: "PEDIDO_NAO_ENCONTRADO" });
    expect(validarRetorno({ code: "c", state: "s1" }, pend, AGORA + PEDIDO_VALIDADE_MS + 1)).toEqual({ ok: false, motivo: "PEDIDO_VENCIDO" });
    expect(validarRetorno({ state: "s1" }, pend, AGORA)).toEqual({ ok: false, motivo: "SEM_CODIGO" });
    expect(validarRetorno({ error: "access_denied", state: "s1" }, pend, AGORA)).toEqual({ ok: false, motivo: "RECUSADO_PELA_ULBRA:access_denied" });
  });
});

describe("cifra dos tokens em repouso", () => {
  it("cifra e decifra com AES-256-GCM; chave errada ou texto adulterado não abrem; chave fora do formato é recusada", async () => {
    const k1 = chaveDeHex("00".repeat(31) + "01");
    const k2 = chaveDeHex("00".repeat(31) + "02");
    const c = await cifrar("rt-secreto", k1);
    expect(c).not.toContain("rt-secreto");
    expect(await decifrar(c, k1)).toBe("rt-secreto");
    await expect(decifrar(c, k2)).rejects.toBeTruthy();
    await expect(decifrar(c.slice(0, -2) + "AA", k1)).rejects.toBeTruthy();
    expect(() => chaveDeHex("curta")).toThrow("CHAVE_INVALIDA");
    // dois cifrados do mesmo texto são diferentes (IV aleatório)
    expect(await cifrar("rt-secreto", k1)).not.toBe(c);
  });
});

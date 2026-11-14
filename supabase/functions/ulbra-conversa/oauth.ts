// ===========================================================================
// OAUTH INDIVIDUAL DO OPERADOR com a Mensageria ULBRA — lógica pura, sem Deno.
//
// O que o servidor da Mensageria publica (lido em 11/11/2026, sem credencial):
//   recurso:  https://crm.ulbra.ai/.well-known/oauth-protected-resource
//             -> authorization_servers: ["https://crm.ulbra.ai/api/oauth"]
//             -> escopos: mcp:acesso, conversas:read, mensagens:enviar, ...
//   servidor: https://crm.ulbra.ai/.well-known/oauth-authorization-server/api/oauth
//             -> authorization_code + refresh_token, PKCE S256,
//                token_endpoint_auth_methods_supported: ["none"] (cliente público),
//                revocation_endpoint, SEM registration_endpoint anunciado.
//
// Consequência: o ReATIVA é um CLIENTE PÚBLICO com PKCE. O que depende da TI da
// ULBRA é só o `client_id` registrado para o ReATIVA com a `redirect_uri`
// (sem registro dinâmico anunciado). Tudo o mais é padrão e está aqui.
//
// Nada neste módulo chama a rede: a troca de código e a renovação entram por
// `fetch` injetado, para teste sem rede.
// ===========================================================================

export const AUTORIZACAO_SERVIDOR = "https://crm.ulbra.ai/api/oauth";
export const RECURSO_MCP = "https://crm.ulbra.ai/api/mcp";
export const ENDPOINT_AUTH = `${AUTORIZACAO_SERVIDOR}/auth`;
export const ENDPOINT_TOKEN = `${AUTORIZACAO_SERVIDOR}/token`;
export const ENDPOINT_REVOGACAO = `${AUTORIZACAO_SERVIDOR}/token/revocation`;

/** Só o necessário para ler histórico e responder como a própria pessoa. Nada de campanhas, equipes ou fila. */
export const ESCOPOS_MINIMOS = ["mcp:acesso", "conversas:read", "mensagens:enviar", "atendimentos:read"] as const;

/** Validade do pedido de conexão (state + verifier guardados) até o retorno do navegador. */
export const PEDIDO_VALIDADE_MS = 10 * 60 * 1000;

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Verifier de 64 bytes aleatórios (base64url, 86 chars) e challenge S256, como o RFC 7636. */
export async function gerarPkce(
  aleatorio: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = base64url(aleatorio(64));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  const state = base64url(aleatorio(24));
  return { verifier, challenge, state };
}

export interface ParametrosAutorizacao {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  escopos?: readonly string[];
}

/** URL para o navegador do OPERADOR (não do servidor): ele autoriza na tela da própria Mensageria. */
export function urlDeAutorizacao(p: ParametrosAutorizacao): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: (p.escopos ?? ESCOPOS_MINIMOS).join(" "),
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    // RFC 8707: o token é para o recurso MCP, não para outro serviço da ULBRA.
    resource: RECURSO_MCP,
  });
  return `${ENDPOINT_AUTH}?${q.toString()}`;
}

export interface TokensRecebidos {
  access_token: string;
  refresh_token: string | null;
  /** Instante (ms) em que o access_token vence, calculado a partir de expires_in. */
  expira_em_ms: number;
  escopo: string | null;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

function lerTokens(corpo: string, agoraMs: number): TokensRecebidos {
  let j: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  try {
    j = JSON.parse(corpo);
  } catch {
    throw new Error("TOKEN_RESPOSTA_INVALIDA");
  }
  if (typeof j.access_token !== "string" || !j.access_token) throw new Error("TOKEN_SEM_ACCESS_TOKEN");
  const expiresIn = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 3600;
  return {
    access_token: j.access_token,
    refresh_token: typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : null,
    expira_em_ms: agoraMs + expiresIn * 1000,
    escopo: typeof j.scope === "string" ? j.scope : null,
  };
}

/** Troca o código pelo token (cliente público: sem segredo, com code_verifier). 1 requisição ao servidor OAuth; não é chamada do MCP. */
export async function trocarCodigo(
  p: { clientId: string; redirectUri: string; code: string; verifier: string },
  fetchFn: Fetch,
  agoraMs: number,
): Promise<TokensRecebidos> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: p.clientId,
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
    resource: RECURSO_MCP,
  }).toString();
  const r = await fetchFn(ENDPOINT_TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
  const texto = await r.text();
  if (!r.ok) throw new Error(`TOKEN_HTTP_${r.status}`);
  return lerTokens(texto, agoraMs);
}

/** Renova com o refresh_token (rotacionado pelo servidor quando ele devolve outro). */
export async function renovarToken(
  p: { clientId: string; refreshToken: string },
  fetchFn: Fetch,
  agoraMs: number,
): Promise<TokensRecebidos> {
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: p.clientId, refresh_token: p.refreshToken, resource: RECURSO_MCP }).toString();
  const r = await fetchFn(ENDPOINT_TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
  const texto = await r.text();
  if (!r.ok) throw new Error(`RENOVACAO_HTTP_${r.status}`);
  return lerTokens(texto, agoraMs);
}

/** Revoga no servidor (RFC 7009). Erro aqui não impede a revogação local. */
export async function revogarToken(p: { clientId: string; token: string }, fetchFn: Fetch): Promise<void> {
  const body = new URLSearchParams({ token: p.token, client_id: p.clientId }).toString();
  const r = await fetchFn(ENDPOINT_REVOGACAO, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`REVOGACAO_HTTP_${r.status}`);
}

/** O retorno do navegador só vale com o MESMO state, dentro da validade, e com código presente. */
export function validarRetorno(
  retorno: { code?: unknown; state?: unknown; error?: unknown },
  pendente: { state: string; criado_em_ms: number } | null,
  agoraMs: number,
): { ok: true; code: string } | { ok: false; motivo: string } {
  if (typeof retorno.error === "string" && retorno.error) return { ok: false, motivo: `RECUSADO_PELA_ULBRA:${retorno.error}` };
  if (!pendente) return { ok: false, motivo: "PEDIDO_NAO_ENCONTRADO" };
  if (agoraMs - pendente.criado_em_ms > PEDIDO_VALIDADE_MS) return { ok: false, motivo: "PEDIDO_VENCIDO" };
  if (typeof retorno.state !== "string" || retorno.state !== pendente.state) return { ok: false, motivo: "STATE_DIFERENTE" };
  if (typeof retorno.code !== "string" || !retorno.code) return { ok: false, motivo: "SEM_CODIGO" };
  return { ok: true, code: retorno.code };
}

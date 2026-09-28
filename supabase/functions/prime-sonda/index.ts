// Edge Function: prime-sonda
// -----------------------------------------------------------------------------
// SONDA DE ROTA. Consulta um caminho arbitrario da API do Prime e devolve a
// FORMA do que chega -- nomes de campo, tipos e um exemplo curto por campo.
//
// Existe porque a conclusao "o Prime nao tem a composicao do acordo" foi tirada
// de UM endpoint (/students/{matricula}), e isso nao prova nada sobre a API
// inteira. Amanda, 01/09: "voce nao esta indo a fundo no prime".
//
// SO LE. Nao grava nada, e por padrao NAO devolve dado pessoal -- devolve a
// estrutura. `cru:true` devolve o conteudo, e existe para conferir um caso
// concreto quando a estrutura ja e conhecida.
//
// A chave da Ulbra da acesso a CPF e dados financeiros de ~400 mil pessoas:
// vive so no Vault, nunca no navegador, nunca no repositorio. O acesso a esta
// funcao exige o token de rotina.
//
// VERSIONADA em 2026-09-22 a partir de produção (versão 4) -- existia só em
// produção até esta data. É o instrumento recomendado para qualquer sondagem
// futura de endpoint novo -- ver docs/integracoes/prime-api.md, seção "Como
// confirmar um endpoint novo, com segurança".

const BASE = "https://prime-api.ulbra.ai/api";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-rotina-token",
};

function forma(v: unknown, prof = 0): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    return { _lista: v.length, _item: v.length ? forma(v[0], prof + 1) : null };
  }
  if (typeof v === "object") {
    if (prof > 4) return "{...}";
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = forma(val, prof + 1);
    return o;
  }
  const s = String(v);
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const esperado = Deno.env.get("ROTINA_TOKEN") ?? Deno.env.get("PRIME_CADASTRO_TOKEN") ?? "";
  const recebido = req.headers.get("x-rotina-token") ?? "";
  if (esperado && recebido !== esperado) {
    return new Response(JSON.stringify({ erro: "token invalido" }),
      { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // a chave sai do Vault pela RPC, que so atende service_role
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const srv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  let chave = Deno.env.get("PRIME_API_KEY") ?? "";
  if (!chave && url && srv) {
    const r = await fetch(url + "/rest/v1/rpc/prime_chave_api", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: srv, Authorization: "Bearer " + srv },
      body: "{}",
    });
    if (r.ok) chave = (await r.json()) as string;
  }
  if (!chave) {
    return new Response(JSON.stringify({ erro: "chave do Prime indisponivel" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const corpo = await req.json().catch(() => ({}));
  const caminho = String(corpo?.caminho ?? "").trim();
  const cru = corpo?.cru === true;
  if (!caminho.startsWith("/")) {
    return new Response(JSON.stringify({ erro: "informe o caminho, comecando com /" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const r = await fetch(BASE + caminho, { headers: { "X-API-Key": chave } });
  const texto = await r.text();
  let dados: unknown = null;
  try { dados = JSON.parse(texto); } catch { /* nem sempre e JSON */ }

  return new Response(JSON.stringify({
    caminho,
    status: r.status,
    tipo: r.headers.get("content-type"),
    tamanho: texto.length,
    forma: dados === null ? texto.slice(0, 500) : forma(dados),
    ...(cru ? { cru: dados ?? texto.slice(0, 4000) } : {}),
  }, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
});

// Edge Function: documento-financeiro-url
// -----------------------------------------------------------------------------
// Entrega privada de COMPROVANTES DE PAGAMENTO (bucket `comprovantes-pagamento`)
// e TERMOS DE ACORDO (bucket `termos-acordo`), ambos PRIVADOS.
//
// Substitui o padrão inseguro anterior (URL pública gravada no banco +
// createSignedUrl no NAVEGADOR), que dependia de policy SELECT ampla e permitia
// a qualquer usuário autenticado assinar/enumerar QUALQUER objeto dos buckets.
//
// CONTRATO (server-side signing, caminho NUNCA vem do cliente):
//   Entrada (POST, JSON) — somente ID seguro do registro:
//     { "tipo": "comprovante_link", "id": "<uuid links_pagamento>" }
//     { "tipo": "comprovante_baixa", "id": "<uuid baixas_pagamento>" }
//     { "tipo": "termo", "id": "<uuid termos_acordo>", "campo": "arquivo" | "rg" | "verso" }
//   Saída (JSON):
//     { "url": "<signedUrl 300s>" }            // sucesso
//     { "error": "<codigo>" }                  // erro controlado (sem vazar caminho)
//
// Fluxo:
//   1) valida o JWT do solicitante;
//   2) confirma cadastrado E ativo (perfil_do_usuario_atual() != null);
//   3) recebe apenas tipo + id (UUID) [+ campo p/ termo]; ignora qualquer
//      caminho/URL enviado pelo cliente;
//   4) consulta a tabela dona NO SERVIDOR (service role) e obtém a coluna de
//      URL/caminho + o operador dono do registro;
//   5) autoriza: gestão financeira vê tudo; operador só vê o registro cujo
//      operador_email é o dele (vínculo por ID/relação do banco, nunca por
//      nome/CPF/e-mail informado pelo cliente);
//   6) resolve o caminho INTERNO (aceita tanto URL pública legada quanto
//      caminho interno já migrado), valida contra path traversal / bucket
//      cruzado / URL completa;
//   7) assina SOMENTE esse objeto, no bucket correto, TTL 300s;
//   8) nunca devolve o caminho interno; objeto órfão/sem vínculo não é assinado.
//
// Nunca assina caminho arbitrário do navegador. Nunca loga id, caminho ou URL.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TTL_SEGUNDOS = 300; // 5 min (máximo permitido)
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Espelha public.usuario_e_gestao() — gestão financeira autorizada a ver tudo.
const GESTAO = new Set([
  "amanda.seibel@aelbra.com.br",
  "cobranca04@aelbra.com.br",
  "cobranca07@aelbra.com.br",
]);

// Descreve cada tipo de documento: tabela dona, coluna de URL/caminho, coluna
// do operador dono e o bucket em que o objeto vive.
type Fonte = { tabela: string; colunaUrl: string; colunaDono: string; bucket: string };

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Resolve (tipo, campo) -> Fonte. Retorna null p/ combinação inválida.
function resolverFonte(tipo: unknown, campo: unknown): Fonte | null {
  if (tipo === "comprovante_link") {
    return { tabela: "links_pagamento", colunaUrl: "comprovante_url", colunaDono: "operador_email", bucket: "comprovantes-pagamento" };
  }
  if (tipo === "comprovante_baixa") {
    return { tabela: "baixas_pagamento", colunaUrl: "comprovante_url", colunaDono: "responsavel_baixa_email", bucket: "comprovantes-pagamento" };
  }
  if (tipo === "termo") {
    const col = campo === "rg" ? "arquivo_rg_url" : campo === "verso" ? "arquivo_verso_url" : campo === "arquivo" || campo == null ? "arquivo_url" : null;
    if (!col) return null;
    return { tabela: "termos_acordo", colunaUrl: col, colunaDono: "operador_email", bucket: "termos-acordo" };
  }
  return null;
}

// Converte o valor gravado (URL pública legada OU caminho interno já migrado)
// no caminho INTERNO do objeto, restrito ao bucket esperado. Rejeita URL
// completa de outro host/bucket, path traversal, barra inicial e vazio.
function caminhoInterno(valor: unknown, bucket: string): string | null {
  if (typeof valor !== "string") return null;
  let s = valor.trim();
  if (s.length === 0 || s.length > 2048) return null;

  // URL pública/assinada legada -> extrai só a parte após /object/<...>/<bucket>/
  const m = s.match(/\/object\/(?:public|sign)\/([a-z0-9-]+)\/(.+?)(?:\?.*)?$/i);
  if (m) {
    if (m[1] !== bucket) return null; // referencia outro bucket
    s = m[2];
  } else if (s.includes("://")) {
    return null; // URL completa que não é do storage esperado
  }

  s = decodeURIComponent(s);
  if (s.startsWith("/")) return null;
  if (s.includes("..")) return null;
  if (/\/object\//i.test(s)) return null;
  if (s.length === 0) return null;
  return s;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
    return json({ error: "server_misconfigured" }, 500);
  }

  // 1) Identidade + gate de cadastrado/ativo no contexto do usuário (JWT).
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

  const { data: perfil, error: perfilErr } = await userClient.rpc("perfil_do_usuario_atual");
  if (perfilErr || !perfil) return json({ error: "forbidden" }, 403); // sem cadastro/inativo

  const emailSolicitante = (userData.user.email || "").toLowerCase();
  const ehGestao = GESTAO.has(emailSolicitante);

  // 2) Entrada: SOMENTE tipo + id (+ campo). Ignora qualquer caminho/URL.
  let body: { tipo?: unknown; id?: unknown; campo?: unknown } = {};
  try {
    body = await req.json();
  } catch (_e) {
    body = {};
  }
  const fonte = resolverFonte(body?.tipo, body?.campo);
  if (!fonte) return json({ error: "bad_request" }, 400);
  const id = typeof body?.id === "string" ? body.id : "";
  if (!RE_UUID.test(id)) return json({ error: "bad_request" }, 400);

  // 3) Busca o registro NO SERVIDOR (service role). O cliente nunca informa o caminho.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: registro, error: dbErr } = await admin
    .from(fonte.tabela)
    .select(`${fonte.colunaUrl}, ${fonte.colunaDono}`)
    .eq("id", id)
    .maybeSingle();
  if (dbErr) return json({ error: "lookup_failed" }, 500);
  if (!registro) return json({ error: "not_found" }, 404); // ID inexistente => resposta controlada

  // 4) Autorização por VÍNCULO do banco: gestão vê tudo; operador só o seu.
  const dono = String((registro as Record<string, unknown>)[fonte.colunaDono] ?? "").toLowerCase();
  if (!ehGestao && (!dono || dono !== emailSolicitante)) {
    return json({ error: "forbidden" }, 403);
  }

  // 5) Resolve o caminho interno e assina apenas esse objeto.
  const caminho = caminhoInterno((registro as Record<string, unknown>)[fonte.colunaUrl], fonte.bucket);
  if (!caminho) return json({ error: "sem_documento" }, 404); // órfão/ausente/adulterado

  const { data: assinada, error: signErr } = await admin.storage
    .from(fonte.bucket)
    .createSignedUrl(caminho, TTL_SEGUNDOS);
  if (signErr || !assinada?.signedUrl) return json({ error: "sign_failed" }, 500);

  return json({ url: assinada.signedUrl }, 200);
});

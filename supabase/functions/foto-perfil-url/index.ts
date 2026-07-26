// Edge Function: foto-perfil-url
// -----------------------------------------------------------------------------
// Entrega privada das fotos de perfil (bucket `fotos-perfil`, PRIVADO).
//
// CONTRATO (server-side signing, caminho NUNCA vem do cliente):
//   Entrada (POST, JSON): { "usuario_ids": ["<uuid>", ...] }   // só IDs
//   Saída   (JSON):       { "urls": { "<usuario_id>": "<signedUrl 300s>" } }
//
// Fluxo:
//   1) valida o JWT do solicitante;
//   2) confirma que o solicitante está CADASTRADO e ATIVO
//      (public.perfil_do_usuario_atual() != null);
//   3) recebe apenas usuario_id(s) (UUID); ignora qualquer caminho/URL enviado;
//   4) consulta public.usuarios NO SERVIDOR e obtém foto_path do registro;
//   5) valida que o caminho é interno e seguro (sem ../, sem barra inicial,
//      sem esquema http, sem referência a /object/ ou a outro bucket);
//   6) assina SOMENTE esse caminho, no bucket fotos-perfil, com service role
//      (apenas no servidor), TTL 300s;
//   7) não retorna o caminho interno; quando não houver foto válida, o id
//      simplesmente não aparece em `urls` (frontend mostra o avatar padrão).
//
// Nunca assina caminho arbitrário do navegador. Nunca loga id, caminho ou URL.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TTL_SEGUNDOS = 300; // 5 min
const BUCKET = "fotos-perfil";
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Aceita apenas caminho INTERNO do objeto. Rejeita URL completa, barra inicial,
// path traversal, referência a /object/ (caminho de storage) e vazio.
function caminhoInternoSeguro(p: unknown): p is string {
  if (typeof p !== "string") return false;
  const s = p.trim();
  if (s.length === 0 || s.length > 1024) return false;
  if (s.startsWith("/")) return false;
  if (s.includes("..")) return false;
  if (s.includes("://")) return false; // URL completa
  if (/\/object\//i.test(s)) return false; // caminho de storage / outro bucket
  return true;
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

  // 1) Identidade + autorização no contexto do usuário (JWT do chamador).
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

  // NULL => sem cadastro ou inativo => bloqueado.
  const { data: perfil, error: perfilErr } = await userClient.rpc("perfil_do_usuario_atual");
  if (perfilErr || !perfil) return json({ error: "forbidden" }, 403);

  // 2) Coleta SOMENTE usuario_ids (UUID). Ignora qualquer outro campo do corpo.
  let body: { usuario_ids?: unknown } = {};
  try {
    body = await req.json();
  } catch (_e) {
    body = {};
  }
  const brutos = Array.isArray(body?.usuario_ids) ? (body.usuario_ids as unknown[]) : [];
  const ids = Array.from(
    new Set(brutos.filter((v): v is string => typeof v === "string" && RE_UUID.test(v))),
  ).slice(0, 100);

  const urls: Record<string, string> = {};
  if (ids.length === 0) return json({ urls }, 200);

  // 3) Busca os caminhos NO SERVIDOR (service role). O cliente nunca informa o caminho.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: registros, error: dbErr } = await admin
    .from("usuarios")
    .select("id, foto_path")
    .in("id", ids);
  if (dbErr) return json({ error: "lookup_failed" }, 500);

  // 4) Assina apenas caminhos internos válidos, no bucket fotos-perfil.
  for (const reg of registros ?? []) {
    const foto = (reg as { id: string; foto_path: string | null }).foto_path;
    if (!caminhoInternoSeguro(foto)) continue; // órfão/ausente/adulterado => avatar padrão
    const objeto = decodeURIComponent(foto);
    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(objeto, TTL_SEGUNDOS);
    if (!error && data?.signedUrl) urls[(reg as { id: string }).id] = data.signedUrl;
  }

  return json({ urls }, 200);
});

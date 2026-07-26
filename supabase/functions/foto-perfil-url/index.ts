// Edge Function: foto-perfil-url
// -----------------------------------------------------------------------------
// Entrega privada das fotos de perfil (bucket `fotos-perfil`, PRIVADO).
//
// Arquitetura escolhida (server-side signing):
//   - O bucket é PRIVADO e NÃO possui policy SELECT para `authenticated`, logo o
//     cliente não consegue ler nem LISTAR objetos (zero enumeração, nem por
//     usuário logado). O anon é totalmente bloqueado.
//   - Esta função assina URLs de curta duração usando a SERVICE ROLE, que existe
//     APENAS no servidor (variável de ambiente). A service role NUNCA é enviada
//     ao navegador.
//   - Antes de assinar, valida que o chamador é usuário AUTENTICADO, CADASTRADO e
//     ATIVO, reusando o controle central public.perfil_do_usuario_atual()
//     (retorna NULL para sem-cadastro/inativo).
//
// Entrada  (POST, JSON): { "paths": ["<caminho-interno-do-objeto>", ...] }
// Saída    (JSON):       { "urls": { "<caminho>": "<signedUrl-curta-duração>" } }
//
// Não retorna nada para caminhos inexistentes/inacessíveis (fallback no client).
// Não registra caminhos, e-mails nem URLs (sem log de dado pessoal).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TTL_SEGUNDOS = 300; // 5 min

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
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

  // Reusa o controle central: NULL => sem cadastro ou inativo => bloqueado.
  const { data: perfil, error: perfilErr } = await userClient.rpc("perfil_do_usuario_atual");
  if (perfilErr || !perfil) return json({ error: "forbidden" }, 403);

  // 2) Coleta os caminhos solicitados (defensivo contra traversal).
  let body: { paths?: unknown } = {};
  try {
    body = await req.json();
  } catch (_e) {
    body = {};
  }
  const brutos = Array.isArray(body?.paths) ? (body.paths as unknown[]) : [];
  const paths = brutos
    .filter((p): p is string => typeof p === "string" && p.length > 0 && !p.includes(".."))
    .slice(0, 100);

  // 3) Assina com service role (somente no servidor), curta duração.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const urls: Record<string, string> = {};
  for (const p of paths) {
    const objeto = decodeURIComponent(p);
    const { data, error } = await admin.storage
      .from("fotos-perfil")
      .createSignedUrl(objeto, TTL_SEGUNDOS);
    if (!error && data?.signedUrl) urls[p] = data.signedUrl;
  }

  return json({ urls }, 200);
});

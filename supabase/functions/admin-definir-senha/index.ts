// Edge Function: admin-definir-senha
// -----------------------------------------------------------------------------
// Gestão define a senha inicial (ou troca) de um usuário do CRM, sem e-mail.
//
// Entrada (POST, JSON): { "email": "<e-mail do usuário>", "nova_senha": "<texto>" }
// Saída: { "ok": true } | { "error": "..." }
//
// Fluxo:
//   1) valida o JWT do solicitante (Authorization Bearer);
//   2) confirma com a própria sessão do solicitante que ele é gestão
//      (public.usuario_e_gestao_fila()); sem isso, 403;
//   3) valida o e-mail e a senha (senha: 10 a 128 caracteres, letra e número,
//      sem espaço nas bordas) e confirma que o e-mail é de um usuário do CRM;
//   4) só então usa a service role, apenas no servidor, para localizar a conta
//      de login pelo e-mail e trocar a senha.
//
// A senha nunca é registrada em log nem devolvida na resposta.
// CORS: aceita apenas a origem definida em CRM_ORIGIN (variável de ambiente).
import { createClient } from "jsr:@supabase/supabase-js@2";

const MIN = 10;
const MAX = 128;
const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

function cabecalhosCors(req: Request): Record<string, string> {
  const permitida = Deno.env.get("CRM_ORIGIN") ?? "";
  const origem = req.headers.get("Origin") ?? "";
  const base: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (permitida && origem === permitida) base["Access-Control-Allow-Origin"] = permitida;
  return base;
}

function json(req: Request, obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cabecalhosCors(req), "Content-Type": "application/json" },
  });
}

function senhaValida(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s.length < MIN || s.length > MAX) return false;
  if (s !== s.trim()) return false;
  return /[A-Za-zÀ-ÿ]/.test(s) && /[0-9]/.test(s);
}

function emailValido(e: unknown): e is string {
  return typeof e === "string" && e.length <= 254 && RE_EMAIL.test(e.trim());
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cabecalhosCors(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json(req, { error: "unauthorized" }, 401);

  let corpo: { email?: unknown; nova_senha?: unknown };
  try {
    corpo = await req.json();
  } catch {
    return json(req, { error: "json_invalido" }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1 e 2: sessão do solicitante, checagem de gestão feita pelo banco.
  const sessao = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: usuario, error: eu } = await sessao.auth.getUser();
  if (eu || !usuario?.user) return json(req, { error: "unauthorized" }, 401);

  const { data: gestao, error: eg } = await sessao.rpc("usuario_e_gestao_fila");
  if (eg || gestao !== true) return json(req, { error: "somente gestao pode definir senha" }, 403);

  // 3: entrada e confirmação de que o e-mail é de um usuário do CRM.
  if (!emailValido(corpo.email)) return json(req, { error: "email invalido" }, 400);
  const email = corpo.email.trim().toLowerCase();
  if (!senhaValida(corpo.nova_senha)) {
    return json(req, { error: "senha fora da regra (10 a 128 caracteres, letra e número, sem espaço nas bordas)" }, 400);
  }

  const { data: cadastro, error: ec } = await sessao
    .from("usuarios")
    .select("email")
    .ilike("email", email)
    .limit(1);
  if (ec || !cadastro || cadastro.length === 0) {
    return json(req, { error: "usuario nao encontrado no CRM" }, 404);
  }

  // 4: localizar a conta de login pelo e-mail e trocar a senha, só com service role.
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  let alvoId: string | null = null;
  for (let pagina = 1; pagina <= 20 && !alvoId; pagina++) {
    const { data: lista, error: el } = await admin.auth.admin.listUsers({ page: pagina, perPage: 200 });
    if (el) return json(req, { error: "nao foi possivel localizar a conta" }, 500);
    const achado = lista.users.find((x) => (x.email ?? "").toLowerCase() === email);
    if (achado) alvoId = achado.id;
    if (lista.users.length < 200) break;
  }
  if (!alvoId) return json(req, { error: "conta de login nao encontrada para este e-mail" }, 404);

  const { error: ea } = await admin.auth.admin.updateUserById(alvoId, { password: corpo.nova_senha });
  if (ea) return json(req, { error: "nao foi possivel definir a senha" }, 500);

  return json(req, { ok: true });
});

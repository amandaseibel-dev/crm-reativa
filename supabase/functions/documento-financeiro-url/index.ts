// Edge Function: documento-financeiro-url
// -----------------------------------------------------------------------------
// Entrega e RECEBIMENTO privados de COMPROVANTES DE PAGAMENTO
// (bucket `comprovantes-pagamento`) e TERMOS DE ACORDO (bucket `termos-acordo`),
// ambos PRIVADOS. Toda autorização é server-side; o cliente nunca escolhe
// bucket, caminho ou nome final, nem recebe service_role.
//
// AÇÕES (campo `acao`, POST JSON):
//   "ler"      -> devolve URL assinada de download (TTL 300s) a partir do ID.
//   "upload"   -> autoriza UM upload: devolve { path, token } de
//                 createSignedUploadUrl (arquivo trafega direto navegador->Storage,
//                 sem passar pela função). Caminho gerado com UUID, sem dado pessoal.
//   "vincular" -> após o upload, confere o objeto e grava o caminho interno na
//                 coluna do registro (vínculo controlado e auditável). Bloqueia
//                 substituição silenciosa (coluna já vinculada).
//
// CONTRATO (somente ID seguro + metadados mínimos; nunca caminho/URL/bucket):
//   ler:      { acao:"ler",   tipo, id, campo? }
//   upload:   { acao:"upload",tipo, id, campo?, mime, tamanho }
//   vincular: { acao:"vincular", tipo, id, campo?, path }   // path = o emitido no upload
//
//   tipo ∈ { "comprovante_link", "comprovante_baixa", "termo" }
//   campo (só termo) ∈ { "arquivo", "rg", "verso" }
//
// Autorização (mesma p/ ler e upload): gestão financeira vê/envia tudo; operador
// só o registro cujo operador dono (operador_email / responsavel_baixa_email) é
// o dele. Vínculo sempre por ID/relação do banco, nunca por nome/CPF/e-mail.
//
// Nunca faz requisição HTTP à URL legada — apenas extrai/valida o caminho local.
// Nunca loga id, caminho, token ou URL.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TTL_SEGUNDOS = 300; // 5 min (máximo permitido) para download
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Host EXATO do projeto Supabase de produção (para validar URL legada).
const HOST_PRODUCAO = "ahattpqrjmhkzsmnbdzs.supabase.co";
const ENDPOINT_PUBLICO = "/storage/v1/object/public/"; // único endpoint legado aceito

// Espelha public.usuario_e_gestao().
const GESTAO = new Set([
  "amanda.seibel@aelbra.com.br",
  "cobranca04@aelbra.com.br",
  "cobranca07@aelbra.com.br",
]);

// MIME permitido por tipo de documento (limite real do fluxo).
const MIME_COMPROVANTE = new Set(["application/pdf", "image/png", "image/jpeg"]);
const MIME_TERMO = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const EXT_POR_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};
const TAMANHO_MAX = 20 * 1024 * 1024; // 20 MB

type Fonte = {
  tabela: string;
  colunaUrl: string;
  colunaDono: string;
  bucket: string;
  mimes: Set<string>;
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Resolve (tipo, campo) -> Fonte. `campo` só é válido p/ termo e restrito a
// arquivo|rg|verso (campo adulterado => null => bad_request).
function resolverFonte(tipo: unknown, campo: unknown): Fonte | null {
  if (tipo === "comprovante_link") {
    return { tabela: "links_pagamento", colunaUrl: "comprovante_url", colunaDono: "operador_email", bucket: "comprovantes-pagamento", mimes: MIME_COMPROVANTE };
  }
  if (tipo === "comprovante_baixa") {
    return { tabela: "baixas_pagamento", colunaUrl: "comprovante_url", colunaDono: "responsavel_baixa_email", bucket: "comprovantes-pagamento", mimes: MIME_COMPROVANTE };
  }
  if (tipo === "termo") {
    const col = campo === "rg" ? "arquivo_rg_url" : campo === "verso" ? "arquivo_verso_url" : campo === "arquivo" ? "arquivo_url" : null;
    if (!col) return null; // campo ausente/adulterado
    return { tabela: "termos_acordo", colunaUrl: col, colunaDono: "operador_email", bucket: "termos-acordo", mimes: MIME_TERMO };
  }
  return null;
}

// --- Validação de caminho interno já migrado (sem URL). ---
function caminhoInternoSimples(s: string): string | null {
  if (/%2e/i.test(s) || s.includes("..")) return null; // traversal (bruto/codificado)
  if (s.includes("://") || /\/object\//i.test(s)) return null;
  let dec: string;
  try {
    dec = decodeURIComponent(s);
  } catch {
    return null; // codificação inválida
  }
  if (dec !== decodeURIComponent(dec)) { /* dupla codificação: dec já é 1 passo */ }
  if (dec.includes("..") || /%2e/i.test(dec)) return null;
  dec = dec.trim();
  if (dec.length === 0 || dec.startsWith("/")) return null;
  return dec;
}

// Resolve o valor GRAVADO (URL pública legada OU caminho interno) no caminho
// interno do objeto, restrito ao bucket esperado. Não faz nenhuma requisição.
function resolverCaminho(valor: unknown, bucketEsperado: string): string | null {
  if (typeof valor !== "string") return null;
  const s = valor.trim();
  if (s.length === 0 || s.length > 2048) return null;

  // (a) Não é URL http(s): trata como caminho interno migrado.
  if (!/^https?:\/\//i.test(s)) {
    if (/^https?:/i.test(s)) return null; // "http:" malformado sem //
    return caminhoInternoSimples(s);
  }

  // (b) URL legada: parse estrito com WHATWG URL.
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;          // só HTTPS
  if (u.hostname !== HOST_PRODUCAO) return null;      // host exato do projeto
  if (u.port && u.port !== "443" && u.port !== "") return null;
  if (u.username || u.password) return null;          // sem user:senha
  if (u.hash) return null;                            // sem fragmento
  if (u.search) return null;                          // sem query (legado público não tem)

  // pathname deve começar EXATAMENTE pelo endpoint público de Storage.
  const p = u.pathname; // já normalizado pelo WHATWG (colapsa //, resolve . e ..)
  if (!p.startsWith(ENDPOINT_PUBLICO)) return null;
  const resto = p.slice(ENDPOINT_PUBLICO.length); // "<bucket>/<caminho...>"
  const barra = resto.indexOf("/");
  if (barra <= 0) return null;
  const bucket = resto.slice(0, barra);
  if (bucket !== bucketEsperado) return null;        // bucket extraído == previsto
  const caminhoBruto = resto.slice(barra + 1);
  if (!caminhoBruto) return null;                    // caminho vazio
  return caminhoInternoSimples(caminhoBruto);
}

// Contexto autenticado + gate cadastrado/ativo. Retorna email ou null.
async function identificar(authHeader: string, url: string, anon: string): Promise<{ email: string } | null> {
  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return null;
  const { data: perfil, error: perfilErr } = await userClient.rpc("perfil_do_usuario_atual");
  if (perfilErr || !perfil) return null; // sem cadastro/inativo
  return { email: (userData.user.email || "").toLowerCase() };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) return json({ error: "server_misconfigured" }, 500);

  const ident = await identificar(authHeader, SUPABASE_URL, ANON_KEY);
  if (!ident) return json({ error: "forbidden" }, 403);
  const ehGestao = GESTAO.has(ident.email);

  let body: { acao?: unknown; tipo?: unknown; id?: unknown; campo?: unknown; mime?: unknown; tamanho?: unknown; path?: unknown } = {};
  try {
    body = await req.json();
  } catch (_e) {
    body = {};
  }

  const acao = body?.acao === "upload" || body?.acao === "vincular" ? body.acao : "ler";
  const fonte = resolverFonte(body?.tipo, body?.campo);
  if (!fonte) return json({ error: "bad_request" }, 400);
  const id = typeof body?.id === "string" ? body.id : "";
  if (!RE_UUID.test(id)) return json({ error: "bad_request" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Carrega o registro e valida autorização por vínculo (comum a todas as ações).
  const { data: registro, error: dbErr } = await admin
    .from(fonte.tabela)
    .select(`${fonte.colunaUrl}, ${fonte.colunaDono}`)
    .eq("id", id)
    .maybeSingle();
  if (dbErr) return json({ error: "lookup_failed" }, 500);
  if (!registro) return json({ error: "not_found" }, 404);

  const dono = String((registro as Record<string, unknown>)[fonte.colunaDono] ?? "").toLowerCase();
  if (!ehGestao && (!dono || dono !== ident.email)) return json({ error: "forbidden" }, 403);

  const valorAtual = (registro as Record<string, unknown>)[fonte.colunaUrl];

  // ---------------------------------------------------------------------------
  // AÇÃO: LER  -> URL assinada de download.
  // ---------------------------------------------------------------------------
  if (acao === "ler") {
    const caminho = resolverCaminho(valorAtual, fonte.bucket);
    if (!caminho) return json({ error: "sem_documento" }, 404);
    const { data, error } = await admin.storage.from(fonte.bucket).createSignedUrl(caminho, TTL_SEGUNDOS);
    if (error || !data?.signedUrl) return json({ error: "sign_failed" }, 500);
    return json({ url: data.signedUrl }, 200);
  }

  // ---------------------------------------------------------------------------
  // AÇÃO: UPLOAD -> autoriza UM upload (signed upload url). Sem sobrescrever
  // documento já vinculado. Caminho com UUID, pasta = id do registro.
  // ---------------------------------------------------------------------------
  if (acao === "upload") {
    if (typeof valorAtual === "string" && valorAtual.trim().length > 0) {
      return json({ error: "ja_vinculado" }, 409); // impede substituição silenciosa
    }
    const mime = typeof body?.mime === "string" ? body.mime : "";
    const tamanho = typeof body?.tamanho === "number" ? body.tamanho : -1;
    if (!fonte.mimes.has(mime)) return json({ error: "mime_invalido" }, 415);
    if (!(tamanho > 0 && tamanho <= TAMANHO_MAX)) return json({ error: "tamanho_invalido" }, 413);

    const ext = EXT_POR_MIME[mime];
    const uuid = crypto.randomUUID();
    // pasta = id do registro (relação do banco); nome = uuid (sem dado pessoal).
    const path = `${id}/${uuid}.${ext}`;
    const { data, error } = await admin.storage.from(fonte.bucket).createSignedUploadUrl(path);
    if (error || !data?.token) return json({ error: "upload_url_failed" }, 500);
    // Retorna path + token (uso único p/ ESTE caminho). Bucket resolvido no servidor.
    return json({ path: data.path ?? path, token: data.token, bucket: fonte.bucket }, 200);
  }

  // ---------------------------------------------------------------------------
  // AÇÃO: VINCULAR -> confere o objeto enviado e grava o caminho na coluna.
  // Vínculo controlado/auditável. Bloqueia sobrescrita e path fora do registro.
  // ---------------------------------------------------------------------------
  if (acao === "vincular") {
    if (typeof valorAtual === "string" && valorAtual.trim().length > 0) {
      return json({ error: "ja_vinculado" }, 409);
    }
    const path = typeof body?.path === "string" ? body.path : "";
    // path emitido tem forma "<id>/<uuid>.<ext>" e pertence a ESTE registro.
    const RE_PATH = new RegExp(`^${id}/[0-9a-f-]{36}\\.(pdf|png|jpg|doc|docx)$`, "i");
    if (!RE_PATH.test(path)) return json({ error: "path_invalido" }, 400);

    // Confirma que o objeto REALMENTE existe no bucket (não vincula órfão).
    const pasta = id;
    const nome = path.slice(pasta.length + 1);
    const { data: lista, error: listErr } = await admin.storage.from(fonte.bucket).list(pasta, { search: nome, limit: 100 });
    if (listErr) return json({ error: "verify_failed" }, 500);
    const existe = Array.isArray(lista) && lista.some((o) => o.name === nome);
    if (!existe) return json({ error: "objeto_ausente" }, 404);

    // Grava o caminho interno + auditoria mínima (só onde já existe coluna).
    const patch: Record<string, unknown> = { [fonte.colunaUrl]: path };
    if (fonte.tabela === "links_pagamento") {
      patch["comprovante_anexado_por"] = ident.email;
      patch["comprovante_anexado_em"] = new Date().toISOString();
    }
    const { error: updErr } = await admin
      .from(fonte.tabela)
      .update(patch)
      .eq("id", id)
      .is(fonte.colunaUrl, null); // trava anti-corrida: só grava se ainda vazio
    if (updErr) return json({ error: "vincular_failed" }, 500);

    // Auditoria operacional já existente (comprovante de link).
    if (fonte.tabela === "links_pagamento") {
      await admin.from("historico_links_pagamento").insert({
        link_pagamento_id: id,
        observacao: "Comprovante anexado (upload autorizado por servidor).",
        usuario_email: ident.email,
      });
    }
    return json({ ok: true }, 200);
  }

  return json({ error: "bad_request" }, 400);
});

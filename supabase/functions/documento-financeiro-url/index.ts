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
// Validade da INTENÇÃO acompanha a validade real do signed upload URL do
// Supabase (~2h). Não alegamos revogação antecipada do token.
const TTL_UPLOAD_SEG = 7200; // 2 h
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

// Garante (idempotente) que um comprovante de CARTÃO vinculado tenha sua
// solicitação na Minha Fila de Baixa. Toda a regra vive na função server-side
// garantir_solicitacao_cartao_na_fila; aqui só a acionamos e REPORTAMOS o
// resultado (não ocultamos falha). Nunca confirma/baixa nem quebra o vínculo.
// Retorna campos para o corpo da resposta:
//   { fila_ok: true }                      -> solicitação existe/foi criada, ou
//                                             não se aplica (não é comprovante
//                                             de link / não é cartão);
//   { fila_ok: false, fila_codigo: "fila_nao_criada" } -> falhou ao criar.
async function garantirFilaCartao(
  admin: ReturnType<typeof createClient>,
  tipoDocumento: unknown,
  registroId: unknown,
): Promise<{ fila_ok: boolean; fila_codigo?: string }> {
  // Não aplicável a termos/baixas ou id inválido: não é falha da fila.
  if (tipoDocumento !== "comprovante_link") return { fila_ok: true };
  if (typeof registroId !== "string" || !RE_UUID.test(registroId)) return { fila_ok: true };
  try {
    const { data, error } = await admin.rpc("garantir_solicitacao_cartao_na_fila", {
      p_link_id: registroId,
    });
    if (error) return { fila_ok: false, fila_codigo: "fila_nao_criada" };
    const d = data as { ok?: boolean; motivo?: string } | null;
    // ok=true (criada/existente) ou motivo 'nao_cartao' (nada a fazer) => sucesso.
    if (d && (d.ok === true || d.motivo === "nao_cartao")) return { fila_ok: true };
    return { fila_ok: false, fila_codigo: "fila_nao_criada" };
  } catch (_e) {
    return { fila_ok: false, fila_codigo: "fila_nao_criada" };
  }
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

  let body: {
    acao?: unknown; tipo?: unknown; id?: unknown; campo?: unknown;
    mime?: unknown; tamanho?: unknown; intent_id?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch (_e) {
    body = {};
  }

  const acao = body?.acao === "upload" || body?.acao === "vincular" ? body.acao : "ler";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ===========================================================================
  // AÇÃO: VINCULAR -> recebe SOMENTE intent_id. Tudo (bucket, caminho, tipo,
  // campo, registro, mime/tamanho esperados) vem da INTENÇÃO armazenada; o
  // cliente não reenvia nada disso. Idempotente e atômico (RPC).
  // ===========================================================================
  if (acao === "vincular") {
    const intentId = typeof body?.intent_id === "string" ? body.intent_id : "";
    if (!RE_UUID.test(intentId)) return json({ error: "bad_request" }, 400);

    const { data: intento, error: intErr } = await admin
      .from("documentos_financeiros_upload_intentos")
      .select("id, tipo_documento, registro_id, campo_documento, bucket, caminho, mime_esperado, tamanho_maximo, solicitado_por, status, expira_em")
      .eq("id", intentId)
      .maybeSingle();
    if (intErr) return json({ error: "lookup_failed" }, 500);
    if (!intento) return json({ error: "not_found" }, 404);

    const it = intento as Record<string, string>;
    const donoIntento = String(it.solicitado_por ?? "").toLowerCase();
    if (!ehGestao && donoIntento !== ident.email) return json({ error: "forbidden" }, 403);

    // Idempotência: já vinculado => devolve o resultado sem reauditar/reescrever.
    // Ainda assim garante a fila do cartão (recupera solicitação ausente).
    if (it.status === "VINCULADO") {
      const f = await garantirFilaCartao(admin, it.tipo_documento, it.registro_id);
      return json({ ok: true, ja_vinculado: true, ...f }, 200);
    }
    if (it.status !== "AUTORIZADO" && it.status !== "ENVIADO") return json({ error: "intencao_invalida" }, 409);
    if (new Date(it.expira_em).getTime() < Date.now()) return json({ error: "intencao_expirada" }, 410);

    const fonteI = resolverFonte(it.tipo_documento, it.campo_documento === "comprovante" ? undefined : it.campo_documento);
    if (!fonteI || fonteI.bucket !== it.bucket) return json({ error: "intencao_invalida" }, 409);

    // Confere o objeto REAL no bucket/caminho da intenção + MIME e tamanho reais.
    const pasta = it.caminho.split("/")[0];
    const nome = it.caminho.slice(pasta.length + 1);
    const { data: lista, error: listErr } = await admin.storage.from(it.bucket).list(pasta, { search: nome, limit: 100 });
    if (listErr) return json({ error: "verify_failed" }, 500);
    const obj = Array.isArray(lista) ? lista.find((o) => o.name === nome) : undefined;
    if (!obj) return json({ error: "objeto_ausente" }, 404);
    const meta = (obj as { metadata?: { mimetype?: string; size?: number } }).metadata || {};
    if (meta.mimetype && meta.mimetype !== it.mime_esperado) return json({ error: "mime_divergente" }, 415);
    if (typeof meta.size === "number" && meta.size > Number(it.tamanho_maximo)) return json({ error: "tamanho_excedido" }, 413);

    // Vinculação ATÔMICA (registro + intenção + auditoria) via RPC SECURITY DEFINER.
    const { data: situacao, error: rpcErr } = await admin.rpc("docfin_vincular", {
      p_intent_id: intentId,
      p_tabela: fonteI.tabela,
      p_coluna: fonteI.colunaUrl,
      p_ator: ident.email,
      p_gestao: ehGestao,
    });
    if (rpcErr) return json({ error: "vincular_failed" }, 500);
    // (A) após vínculo bem-sucedido e (B) no caminho real de 409 ja_vinculado,
    // garante a solicitação do cartão na fila (idempotente; best-effort).
    if (situacao === "OK") {
      const f = await garantirFilaCartao(admin, it.tipo_documento, it.registro_id);
      return json({ ok: true, ...f }, 200);
    }
    if (situacao === "JA_VINCULADO") {
      const f = await garantirFilaCartao(admin, it.tipo_documento, it.registro_id);
      return json({ ok: true, ja_vinculado: true, ...f }, 200);
    }
    if (situacao === "REGISTRO_JA_VINCULADO") {
      const f = await garantirFilaCartao(admin, it.tipo_documento, it.registro_id);
      return json({ error: "ja_vinculado", ...f }, 409);
    }
    if (situacao === "EXPIRADA") return json({ error: "intencao_expirada" }, 410);
    return json({ error: "vincular_falhou" }, 409);
  }

  // ===========================================================================
  // AÇÕES LER / UPLOAD -> exigem tipo + id do registro e autorização por vínculo.
  // ===========================================================================
  const fonte = resolverFonte(body?.tipo, body?.campo);
  if (!fonte) return json({ error: "bad_request" }, 400);
  const id = typeof body?.id === "string" ? body.id : "";
  if (!RE_UUID.test(id)) return json({ error: "bad_request" }, 400);

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
  // AÇÃO: LER  -> URL assinada de download (TTL 300s).
  // ---------------------------------------------------------------------------
  if (acao === "ler") {
    const caminho = resolverCaminho(valorAtual, fonte.bucket);
    if (!caminho) return json({ error: "sem_documento" }, 404);
    const { data, error } = await admin.storage.from(fonte.bucket).createSignedUrl(caminho, TTL_SEGUNDOS);
    if (error || !data?.signedUrl) return json({ error: "sign_failed" }, 500);
    return json({ url: data.signedUrl }, 200);
  }

  // ---------------------------------------------------------------------------
  // AÇÃO: UPLOAD -> cria/reusa uma INTENÇÃO de upload e devolve signed upload URL.
  // upsert:false explícito (nunca sobrescreve); caminho com UUID no servidor.
  // ---------------------------------------------------------------------------
  if (acao === "upload") {
    if (typeof valorAtual === "string" && valorAtual.trim().length > 0) {
      // Registro já tem documento. Este é o caminho de RETRY idempotente da UI
      // (reenvio sem novo upload): reconcilia a fila do cartão e reporta fila_ok.
      const f = await garantirFilaCartao(admin, body?.tipo, id);
      return json({ error: "ja_vinculado", ...f }, 409);
    }
    const mime = typeof body?.mime === "string" ? body.mime : "";
    const tamanho = typeof body?.tamanho === "number" ? body.tamanho : -1;
    if (!fonte.mimes.has(mime)) return json({ error: "mime_invalido" }, 415);
    if (!(tamanho > 0 && tamanho <= TAMANHO_MAX)) return json({ error: "tamanho_invalido" }, 413);

    const campoDoc = body?.tipo === "termo" ? String(body?.campo) : "comprovante";
    const ext = EXT_POR_MIME[mime];

    // Cria ou reusa a intenção (controle server-side, com lock e unicidade).
    const { data: intentos, error: solErr } = await admin.rpc("docfin_solicitar_intento", {
      p_tipo: String(body?.tipo),
      p_registro: id,
      p_campo: campoDoc,
      p_tabela: fonte.tabela,
      p_coluna: fonte.colunaUrl,
      p_bucket: fonte.bucket,
      p_mime: mime,
      p_tam_max: TAMANHO_MAX,
      p_ext: ext,
      p_ttl_seg: TTL_UPLOAD_SEG,
      p_ator: ident.email,
    });
    if (solErr) return json({ error: "intento_failed" }, 500);
    const intento = Array.isArray(intentos) ? intentos[0] : intentos;
    if (!intento) return json({ error: "intento_failed" }, 500);
    if (intento.situacao === "JA_VINCULADO") {
      const f = await garantirFilaCartao(admin, body?.tipo, id);
      return json({ error: "ja_vinculado", ...f }, 409);
    }

    // Autorização de upload p/ o caminho da intenção. upsert:false EXPLÍCITO:
    // nunca sobrescreve objeto existente (o cliente não pode pedir upsert).
    const { data: signed, error: upErr } = await admin.storage
      .from(intento.bucket)
      .createSignedUploadUrl(intento.caminho, { upsert: false });
    if (upErr || !signed?.token) return json({ error: "upload_url_failed" }, 500);

    return json({
      intent_id: intento.intent_id,
      bucket: intento.bucket,
      path: signed.path ?? intento.caminho,
      token: signed.token,
    }, 200);
  }

  return json({ error: "bad_request" }, 400);
});

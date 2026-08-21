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
//   campo (só termo) ∈ { "arquivo", "rg", "verso", "final" }
//     "final" = via COMPLETA (aluno + 2 testemunhas + Ulbra), anexada pela ADM.
//
//   "concluir_assinatura"  -> { acao, id, testemunha_1?, testemunha_2?, backup_confirmado }
//        Marca o termo COMPLETO e, se o backup fora do CRM foi confirmado,
//        DESCARTA do Storage a via só-aluno (+ RG + verso). Só gestão.
//   "descartar_via_aluno"  -> { acao, id, backup_confirmado }
//        Descarte avulso, sem via completa: exige backup confirmado. Só gestão.
//   "desfazer_assinatura"  -> { acao, id, motivo? }
//        "Termo assinado" marcado por engano: volta para A enviar e DESCARTA do
//        Storage o arquivo anexado como via completa. Só gestão.
//   "desfazer_acao"        -> { acao, id, motivo? }   (id = acoes_desfazer.id)
//        Desfaz a ação recém-feita pelo operador (termo, link ou tabulação).
//        NÃO é restrita à gestão: quem autoriza é a RPC desfazer_acao, que
//        confere o dono do cartão e se o item ainda está intocado na fila.
//        Desfazer termo apaga o anexo do Storage -- por isso passa por aqui.
//
// Autorização (mesma p/ ler e upload): gestão financeira vê/envia tudo; operador
// só o registro cujo operador dono (operador_email / responsavel_baixa_email) é
// o dele OU cujo caso do aluno está ATUALMENTE sob sua titularidade (cobre
// remanejamento: quem assume o caso pode anexar o comprovante do link criado por
// outro). Vínculo sempre por ID/relação do banco, nunca por nome/CPF/e-mail.
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
  colunaAluno: string;
  bucket: string;
  mimes: Set<string>;
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Autorização por TITULARIDADE ATUAL do caso: quando o dono direto do registro
// (quem criou o link/baixa/termo) não é o solicitante, ainda liberamos se o
// solicitante for o operador dono do caso VIVO daquele aluno. Cobre o
// remanejamento: ao assumir o caso, o novo operador passa a poder anexar o
// comprovante do link criado por outro. Leitura via service_role (admin), sem
// expor PII; retorna apenas true/false.
async function ehDonoDoCasoAtual(
  admin: ReturnType<typeof createClient>,
  alunoId: unknown,
  email: string,
): Promise<boolean> {
  if (typeof alunoId !== "string" || alunoId.length === 0) return false;
  if (!email) return false;
  const { data, error } = await admin
    .from("casos")
    .select("id")
    .eq("aluno_id", alunoId)
    .ilike("operador_email", email)
    .limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
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

// Fila SOMENTE para cartão. Se o link não for CARTAO (NULL ou outro tipo),
// devolve fila_nao_aplicavel — nunca classifica o pagamento como cartão.
async function filaAposVinculo(
  admin: ReturnType<typeof createClient>,
  tipoDocumento: unknown,
  registroId: unknown,
): Promise<Record<string, unknown>> {
  if (tipoDocumento !== "comprovante_link") return { fila_status: "fila_nao_aplicavel" };
  if (typeof registroId !== "string" || !RE_UUID.test(registroId)) return { fila_status: "fila_nao_aplicavel" };
  const { data: link } = await admin
    .from("links_pagamento")
    .select("forma_pagamento")
    .eq("id", registroId)
    .maybeSingle();
  const forma = String((link as { forma_pagamento?: string } | null)?.forma_pagamento ?? "").toUpperCase();
  if (forma !== "CARTAO") return { fila_status: "fila_nao_aplicavel" };
  return await garantirFilaCartao(admin, "comprovante_link", registroId);
}

// Verifica o objeto REAL no bucket/caminho EXATOS da intenção (sem confiar no
// cliente). Retorna se existe e se é válido (tamanho > 0 e MIME permitido).
async function verificarObjetoIntento(
  admin: ReturnType<typeof createClient>,
  bucket: string,
  caminho: string,
  mimesPermitidos: Set<string>,
): Promise<{ existe: boolean; valido: boolean; erro?: string }> {
  const pasta = caminho.split("/")[0];
  const nome = caminho.slice(pasta.length + 1);
  const { data: lista, error } = await admin.storage.from(bucket).list(pasta, { search: nome, limit: 100 });
  if (error) return { existe: false, valido: false, erro: "verify_failed" };
  const obj = Array.isArray(lista) ? lista.find((o) => o.name === nome) : undefined;
  if (!obj) return { existe: false, valido: false };
  const meta = (obj as { metadata?: { mimetype?: string; size?: number } }).metadata || {};
  const size = typeof meta.size === "number" ? meta.size : 0;
  const mimetype = typeof meta.mimetype === "string" ? meta.mimetype : "";
  const valido = size > 0 && (mimetype === "" || mimesPermitidos.has(mimetype));
  return { existe: true, valido };
}

// Reconcilia um intento cujo objeto JÁ existe e é válido: conclui docfin_vincular
// de forma idempotente (marca o intento VINCULADO e grava a URL) SEM novo upload.
// Devolve a Response pronta. NUNCA sobrescreve objeto nem cria segunda signed URL.
async function reconciliarIntentoExistente(
  admin: ReturnType<typeof createClient>,
  intento: { intent_id: string; bucket: string; caminho: string },
  fonte: Fonte,
  ator: string,
  ehGestao: boolean,
  registroId: string,
): Promise<Response> {
  const chk = await verificarObjetoIntento(admin, intento.bucket, intento.caminho, fonte.mimes);
  if (!chk.existe) return json({ error: "objeto_ausente" }, 404);
  if (!chk.valido) return json({ error: "objeto_invalido" }, 422);

  const { data: situacao, error: rpcErr } = await admin.rpc("docfin_vincular", {
    p_intent_id: intento.intent_id,
    p_tabela: fonte.tabela,
    p_coluna: fonte.colunaUrl,
    p_ator: ator,
    p_gestao: ehGestao,
  });
  if (rpcErr) return json({ error: "vincular_failed" }, 500);
  if (situacao === "EXPIRADA") return json({ error: "intencao_expirada" }, 410);
  const vinculado = situacao === "OK" || situacao === "JA_VINCULADO" || situacao === "REGISTRO_JA_VINCULADO";
  if (!vinculado) return json({ error: "vincular_falhou" }, 409);
  const f = await filaAposVinculo(admin, fonte.tabela === "links_pagamento" ? "comprovante_link" : "", registroId);
  return json({ ok: true, reconciliado: true, jaVinculado: true, ...f }, 200);
}

// Resolve (tipo, campo) -> Fonte. `campo` só é válido p/ termo e restrito a
// arquivo|rg|verso (campo adulterado => null => bad_request).
function resolverFonte(tipo: unknown, campo: unknown): Fonte | null {
  if (tipo === "comprovante_link") {
    return { tabela: "links_pagamento", colunaUrl: "comprovante_url", colunaDono: "operador_email", colunaAluno: "aluno_id", bucket: "comprovantes-pagamento", mimes: MIME_COMPROVANTE };
  }
  if (tipo === "comprovante_baixa") {
    return { tabela: "baixas_pagamento", colunaUrl: "comprovante_url", colunaDono: "responsavel_baixa_email", colunaAluno: "aluno_id", bucket: "comprovantes-pagamento", mimes: MIME_COMPROVANTE };
  }
  if (tipo === "termo") {
    const col = campo === "rg"
      ? "arquivo_rg_url"
      : campo === "verso"
        ? "arquivo_verso_url"
        : campo === "arquivo"
          ? "arquivo_url"
          : campo === "final"
            ? "arquivo_final_url" // via completa: aluno + 2 testemunhas + Ulbra
            : null;
    if (!col) return null; // campo ausente/adulterado
    return { tabela: "termos_acordo", colunaUrl: col, colunaDono: "operador_email", colunaAluno: "aluno_id", bucket: "termos-acordo", mimes: MIME_TERMO };
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

// Remoção física dos anexos de termo. Cada item traz o id da linha de auditoria
// e o caminho; só confirmamos no banco o que o Storage disse ter apagado -- o
// que sobrar fica com removido_do_storage_em NULL, rastreável, em vez de virar
// órfão silencioso.
async function removerAnexosDoStorage(
  // deno-lint-ignore no-explicit-any
  admin: any,
  itensBrutos: unknown,
): Promise<{ marcados: number; removidos: number }> {
  const itens = Array.isArray(itensBrutos)
    ? (itensBrutos as Array<{ id?: string; caminho?: string }>)
    : [];
  const caminhos: string[] = [];
  const idsPorCaminho = new Map<string, string>();
  for (const it of itens) {
    const c = resolverCaminho(it?.caminho, "termos-acordo");
    if (!c || typeof it?.id !== "string") continue;
    caminhos.push(c);
    idsPorCaminho.set(c, it.id);
  }
  if (caminhos.length === 0) return { marcados: 0, removidos: 0 };

  const { data: rem, error: remErr } = await admin.storage.from("termos-acordo").remove(caminhos);
  if (remErr || !Array.isArray(rem)) return { marcados: caminhos.length, removidos: 0 };

  const idsOk = rem
    .map((o: unknown) => idsPorCaminho.get(String((o as { name?: string }).name ?? "")))
    .filter((v: unknown): v is string => typeof v === "string");
  if (idsOk.length > 0) {
    await admin.rpc("termo_confirmar_descarte_storage", { p_ids: idsOk });
  }
  return { marcados: caminhos.length, removidos: idsOk.length };
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

  const ACOES = new Set(["upload", "vincular", "concluir_assinatura", "descartar_via_aluno", "desfazer_assinatura", "desfazer_acao"]);
  const acao = typeof body?.acao === "string" && ACOES.has(body.acao) ? body.acao : "ler";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ===========================================================================
  // AÇÕES DE DESCARTE (só gestão) -> a RPC registra a auditoria e limpa as
  // colunas; aqui só apagamos os objetos do Storage e confirmamos a remoção.
  // Ordem proposital: registrar -> apagar -> confirmar. Se a remoção falhar, a
  // linha de auditoria fica com removido_do_storage_em NULL e o objeto é
  // rastreável em vez de virar órfão silencioso.
  // ===========================================================================
  if (acao === "concluir_assinatura" || acao === "descartar_via_aluno" || acao === "desfazer_assinatura") {
    if (!ehGestao) return json({ error: "forbidden" }, 403);
    const termoId = typeof body?.id === "string" ? body.id : "";
    if (!RE_UUID.test(termoId)) return json({ error: "bad_request" }, 400);
    const backupOk = body?.backup_confirmado === true;

    let resultado: Record<string, unknown> | null = null;
    if (acao === "desfazer_assinatura") {
      // "Termo assinado" marcado por engano: volta para "A enviar" e o arquivo
      // anexado como via completa é descartado (itens devolvidos para remoção).
      const { data, error } = await admin.rpc("termo_desfazer_assinatura_concluida", {
        p_termo_id: termoId,
        p_ator: ident.email,
        p_gestao: true,
        p_motivo: typeof body?.motivo === "string" ? body.motivo.slice(0, 500) : null,
      });
      if (error) return json({ error: "desfazer_assinatura_failed" }, 500);
      resultado = data as Record<string, unknown>;
    } else if (acao === "concluir_assinatura") {
      const { data, error } = await admin.rpc("termo_concluir_assinatura", {
        p_termo_id: termoId,
        p_ator: ident.email,
        p_gestao: true,
        p_testemunha_1: typeof body?.testemunha_1 === "string" ? body.testemunha_1 : null,
        p_testemunha_2: typeof body?.testemunha_2 === "string" ? body.testemunha_2 : null,
        p_backup_confirmado: backupOk,
      });
      if (error) return json({ error: "concluir_failed" }, 500);
      resultado = data as Record<string, unknown>;
    } else {
      if (!backupOk) return json({ error: "backup_nao_confirmado" }, 428);
      const { data, error } = await admin.rpc("termo_descartar_via_aluno", {
        p_termo_id: termoId,
        p_ator: ident.email,
        p_gestao: true,
        p_backup_confirmado: true,
      });
      if (error) return json({ error: "descartar_failed" }, 500);
      resultado = data as Record<string, unknown>;
    }

    if (!resultado || resultado.ok !== true) {
      const cod = String(resultado?.erro ?? "operacao_recusada");
      const status = cod === "acesso_negado" ? 403 : cod === "termo_nao_encontrado" ? 404 : 409;
      return json({ error: cod }, status);
    }

    // Remoção física. Falha NÃO é escondida: o termo já está concluído e a
    // auditoria registrada, mas o objeto continua no bucket e precisa de nova
    // passada.
    const { marcados, removidos } = await removerAnexosDoStorage(admin, resultado.itens);

    return json({
      ok: true,
      etapa: resultado.etapa ?? null,
      descarte: resultado.descarte ?? null,
      arquivos_marcados: marcados,
      arquivos_removidos: removidos,
      pendentes_no_storage: marcados - removidos,
    }, 200);
  }

  // ===========================================================================
  // AÇÃO: DESFAZER -> o operador desfaz o PRÓPRIO erro, então aqui NÃO existe
  // gate de gestão: quem decide se pode é a RPC, que confere o dono do cartão e
  // se o item ainda está intocado na fila do outro lado. Passa pela Edge porque
  // desfazer termo apaga o anexo do Storage, e apagar objeto é privilégio dela.
  // ===========================================================================
  if (acao === "desfazer_acao") {
    const acaoId = typeof body?.id === "string" ? body.id : "";
    if (!RE_UUID.test(acaoId)) return json({ error: "bad_request" }, 400);
    const motivo = typeof body?.motivo === "string" ? body.motivo.slice(0, 500) : null;

    const { data, error } = await admin.rpc("desfazer_acao", {
      p_id: acaoId,
      p_motivo: motivo,
      p_ator: ident.email,
      p_gestao: ehGestao,
    });
    if (error) return json({ error: "desfazer_failed" }, 500);

    const resultado = data as Record<string, unknown> | null;
    if (!resultado || resultado.ok !== true) {
      const cod = String(resultado?.erro ?? "operacao_recusada");
      const status = cod === "nao_e_sua" ? 403
        : cod === "acao_nao_encontrada" ? 404
        : cod === "sem_sessao" ? 401
        : 409;
      return json({ error: cod }, status);
    }

    // Só o termo devolve anexos; link e tabulação voltam com a lista vazia.
    const { marcados, removidos } = await removerAnexosDoStorage(admin, resultado.itens);

    return json({
      ok: true,
      tipo: resultado.tipo ?? null,
      aluno_id: resultado.aluno_id ?? null,
      status_restaurado: resultado.status_restaurado ?? null,
      arquivos_marcados: marcados,
      arquivos_removidos: removidos,
      pendentes_no_storage: marcados - removidos,
    }, 200);
  }

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
      const f = await filaAposVinculo(admin, it.tipo_documento, it.registro_id);
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
      const f = await filaAposVinculo(admin, it.tipo_documento, it.registro_id);
      return json({ ok: true, ...f }, 200);
    }
    if (situacao === "JA_VINCULADO") {
      const f = await filaAposVinculo(admin, it.tipo_documento, it.registro_id);
      return json({ ok: true, ja_vinculado: true, ...f }, 200);
    }
    if (situacao === "REGISTRO_JA_VINCULADO") {
      const f = await filaAposVinculo(admin, it.tipo_documento, it.registro_id);
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
    .select(`${fonte.colunaUrl}, ${fonte.colunaDono}, ${fonte.colunaAluno}`)
    .eq("id", id)
    .maybeSingle();
  if (dbErr) return json({ error: "lookup_failed" }, 500);
  if (!registro) return json({ error: "not_found" }, 404);

  const dono = String((registro as Record<string, unknown>)[fonte.colunaDono] ?? "").toLowerCase();
  if (!ehGestao && (!dono || dono !== ident.email)) {
    // Fallback: dono ATUAL do caso do aluno (cobre remanejamento de titularidade).
    const alunoId = (registro as Record<string, unknown>)[fonte.colunaAluno];
    const donoDoCaso = await ehDonoDoCasoAtual(admin, alunoId, ident.email);
    if (!donoDoCaso) return json({ error: "forbidden" }, 403);
  }

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
      // (reenvio sem novo upload): reconcilia a fila (só cartão) e reporta.
      const f = await filaAposVinculo(admin, body?.tipo, id);
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
      const f = await filaAposVinculo(admin, body?.tipo, id);
      return json({ error: "ja_vinculado", ...f }, 409);
    }

    // Intento REUSADO (tentativa anterior): se o objeto já subiu ao Storage e é
    // válido, NÃO pedir novo upload nem criar outra signed URL — reconcilia
    // (docfin_vincular idempotente) e retorna reconciliado=true. Se o objeto
    // existente for inválido/vazio, não vincula (objeto_invalido).
    if (intento.situacao === "REUSO") {
      const chk = await verificarObjetoIntento(admin, intento.bucket, intento.caminho, fonte.mimes);
      if (chk.existe && chk.valido) {
        return await reconciliarIntentoExistente(admin, intento, fonte, ident.email, ehGestao, id);
      }
      if (chk.existe && !chk.valido) return json({ error: "objeto_invalido" }, 422);
      // objeto ainda não existe: segue para emitir a signed URL do mesmo caminho.
    }

    // Autorização de upload p/ o caminho da intenção. upsert:false EXPLÍCITO:
    // nunca sobrescreve objeto existente (o cliente não pode pedir upsert).
    const { data: signed, error: upErr } = await admin.storage
      .from(intento.bucket)
      .createSignedUploadUrl(intento.caminho, { upsert: false });
    if (upErr || !signed?.token) {
      // Duplicidade (bucketid_objname): o objeto já existe nesse caminho — não é
      // falha. Reconcilia pelo mesmo fluxo em vez de devolver 500.
      const msg = String((upErr as { message?: string } | null)?.message ?? "").toLowerCase();
      const duplicado = msg.includes("duplicate") || msg.includes("already exists") || msg.includes("bucketid_objname") || (upErr as { statusCode?: string } | null)?.statusCode === "409";
      if (duplicado) {
        const chk = await verificarObjetoIntento(admin, intento.bucket, intento.caminho, fonte.mimes);
        if (chk.existe && chk.valido) {
          return await reconciliarIntentoExistente(admin, intento, fonte, ident.email, ehGestao, id);
        }
        if (chk.existe && !chk.valido) return json({ error: "objeto_invalido" }, 422);
      }
      return json({ error: "upload_url_failed" }, 500);
    }

    return json({
      intent_id: intento.intent_id,
      bucket: intento.bucket,
      path: signed.path ?? intento.caminho,
      token: signed.token,
    }, 200);
  }

  return json({ error: "bad_request" }, 400);
});

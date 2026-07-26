// Entrega privada de comprovantes de pagamento e termos de acordo.
// ---------------------------------------------------------------------------
// Os buckets `comprovantes-pagamento` e `termos-acordo` são PRIVADOS e o
// frontend NÃO tem mais SELECT neles. A leitura passa SEMPRE pela Edge Function
// `documento-financeiro-url`, que valida o vínculo do usuário com o registro e
// devolve uma URL assinada de curta duração (300s). O cliente envia apenas o ID
// SEGURO do registro — nunca o caminho do objeto.
//
// Uso:
//   const url = await urlComprovanteLink(linkId);   // links_pagamento.id
//   const url = await urlComprovanteBaixa(baixaId);  // baixas_pagamento.id
//   const url = await urlTermo(termoId, "arquivo");  // termos_acordo.id + campo
//
// Retorna a URL assinada (string) ou null (sem documento / sem permissão).
// NUNCA persistir/cachear a URL assinada; solicitar de novo ao abrir.
import { supabase } from "../services/supabase";

async function assinar(payload) {
  try {
    const { data, error } = await supabase.functions.invoke("documento-financeiro-url", {
      body: payload,
    });
    if (error) return null;
    return data && typeof data.url === "string" ? data.url : null;
  } catch {
    return null; // erro controlado; caller mostra mensagem amigável
  }
}

export function urlComprovanteLink(id) {
  if (!id) return Promise.resolve(null);
  return assinar({ tipo: "comprovante_link", id: String(id) });
}

export function urlComprovanteBaixa(id) {
  if (!id) return Promise.resolve(null);
  return assinar({ tipo: "comprovante_baixa", id: String(id) });
}

export function urlTermo(id, campo = "arquivo") {
  if (!id) return Promise.resolve(null);
  return assinar({ tipo: "termo", id: String(id), campo });
}

// Abre o documento numa nova aba a partir do ID seguro. Trata expiração/erro
// buscando uma URL nova a cada abertura (a assinada nunca é reutilizada).
export async function abrirDocumento(fetcher) {
  const url = await fetcher();
  if (!url) {
    alert("Documento indisponível ou você não tem permissão para visualizá-lo.");
    return;
  }
  window.open(url, "_blank", "noreferrer");
}

// --- UPLOAD AUTORIZADO PELO SERVIDOR --------------------------------------
// Fluxo em 3 passos, sem service_role no cliente e sem escolher bucket/caminho:
//   1) pede autorização (ação "upload") -> { path, token, bucket };
//   2) sobe o arquivo direto navegador->Storage com uploadToSignedUrl (token
//      autorizado para aquele caminho; o servidor controla unicidade via
//      tabela de intenções e upsert:false);
//   3) vincula (ação "vincular") -> servidor grava o caminho no registro.
// Retorna { ok:true } ou { ok:false, erro }. Nunca lança para a UI.
async function enviarDocumento(tipo, id, campo, file) {
  if (!id || !file) return { ok: false, erro: "dados_invalidos" };
  try {
    const { data: auth, error: authErr } = await supabase.functions.invoke("documento-financeiro-url", {
      body: { acao: "upload", tipo, id: String(id), campo, mime: file.type, tamanho: file.size },
    });
    if (authErr || !auth?.intent_id || !auth?.path || !auth?.token || !auth?.bucket) {
      // Propaga "ja_vinculado" para a UI diferenciar mensagem.
      return { ok: false, erro: authErr?.context?.body?.error || "nao_autorizado" };
    }

    // Sobe direto navegador->Storage. Bucket/caminho/token vieram do servidor e
    // NÃO são persistidos nem logados aqui.
    const { error: upErr } = await supabase.storage
      .from(auth.bucket)
      .uploadToSignedUrl(auth.path, auth.token, file);
    if (upErr) return { ok: false, erro: "falha_upload" };

    // Vincular envia SOMENTE o intent_id; o servidor obtém o resto da intenção.
    const { data: vinc, error: vincErr } = await supabase.functions.invoke("documento-financeiro-url", {
      body: { acao: "vincular", intent_id: auth.intent_id },
    });
    if (vincErr || !vinc?.ok) return { ok: false, erro: "falha_vinculo" };

    return { ok: true };
  } catch {
    return { ok: false, erro: "erro_inesperado" };
  }
}

export function enviarComprovanteLink(id, file) {
  return enviarDocumento("comprovante_link", id, undefined, file);
}
export function enviarComprovanteBaixa(id, file) {
  return enviarDocumento("comprovante_baixa", id, undefined, file);
}
export function enviarTermo(id, campo, file) {
  return enviarDocumento("termo", id, campo, file);
}

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

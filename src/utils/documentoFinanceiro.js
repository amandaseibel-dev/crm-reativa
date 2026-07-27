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
// Retorna sempre um objeto (nunca lança para a UI):
//   { ok:true }                      -> anexado agora
//   { ok:true, jaVinculado:true }    -> já estava vinculado (idempotente)
//   { ok:false, erro, status?, etapa? } -> falha real (código preservado)
//
// Códigos de `erro` possíveis (a UI mapeia mensagem): "sessao_expirada" (401),
// "acesso_negado" (403/42501), "mime_invalido", "tamanho_invalido",
// "falha_upload", "falha_vinculo", "dados_invalidos", ou o código bruto da
// Edge Function quando não reconhecido. NUNCA registramos CPF/nome/arquivo.

// Invoca a Edge Function e normaliza status HTTP + código de erro do corpo.
// supabase-js entrega respostas não-2xx como erro com a Response em `context`.
async function invocarDocfin(body) {
  const { data, error } = await supabase.functions.invoke("documento-financeiro-url", { body });
  if (!error) return { ok: true, data, status: 200, code: null };
  let status = 0;
  let code = null;
  try {
    status = error?.context?.status ?? 0;
    const corpo = await error.context.clone().json();
    code = corpo?.error || null;
  } catch {
    // corpo não-JSON / indisponível: ficamos só com o status.
  }
  return { ok: false, data: null, status, code, error };
}

// Renova a sessão uma única vez (usado só em 401). true se obteve nova sessão.
async function renovarSessao() {
  try {
    const { data, error } = await supabase.auth.refreshSession();
    return !error && !!data?.session;
  } catch {
    return false;
  }
}

// Traduz um resultado de invocarDocfin já sabidamente falho em um `erro` estável
// para a UI, sem mascarar 403/42501/desconhecidos.
function erroReal(res, etapa) {
  if (res.status === 403 || res.code === "acesso_negado") return { ok: false, erro: "acesso_negado", status: res.status, etapa };
  if (res.code === "mime_invalido" || res.code === "tamanho_invalido") return { ok: false, erro: res.code, status: res.status, etapa };
  return { ok: false, erro: res.code || "nao_autorizado", status: res.status, etapa };
}

async function enviarDocumento(tipo, id, campo, file) {
  if (!id || !file) return { ok: false, erro: "dados_invalidos" };
  try {
    let renovou401 = false;
    // Até 2 passadas: a 2ª só ocorre para renovar 401 uma vez OU para pedir uma
    // intenção nova após intenção expirada/inválida (repetição única do upload).
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      // 1) Autorização de upload (cria/reusa a intenção no servidor).
      const auth = await invocarDocfin({ acao: "upload", tipo, id: String(id), campo, mime: file.type, tamanho: file.size });
      if (!auth.ok) {
        // Já vinculado: sucesso idempotente — não reenviar o arquivo.
        if (auth.code === "ja_vinculado") return { ok: true, jaVinculado: true };
        if (auth.status === 401) {
          if (!renovou401 && (await renovarSessao())) { renovou401 = true; continue; }
          return { ok: false, erro: "sessao_expirada", status: 401, etapa: "upload" };
        }
        return erroReal(auth, "upload");
      }
      const a = auth.data;
      if (!a?.intent_id || !a?.path || !a?.token || !a?.bucket) return { ok: false, erro: "nao_autorizado", etapa: "upload" };

      // 2) Upload direto navegador->Storage. upsert:false (unicidade no servidor).
      const { error: upErr } = await supabase.storage.from(a.bucket).uploadToSignedUrl(a.path, a.token, file);
      if (upErr) return { ok: false, erro: "falha_upload", etapa: "upload" };

      // 3) Vincular (só intent_id; o servidor obtém o resto da intenção).
      const vinc = await invocarDocfin({ acao: "vincular", intent_id: a.intent_id });
      if (vinc.ok && vinc.data?.ok) return { ok: true, jaVinculado: !!vinc.data?.ja_vinculado };
      // Registro já vinculado no passo de vínculo: também é sucesso idempotente.
      if (vinc.code === "ja_vinculado") return { ok: true, jaVinculado: true };
      if (vinc.status === 401) {
        if (!renovou401 && (await renovarSessao())) { renovou401 = true; continue; }
        return { ok: false, erro: "sessao_expirada", status: 401, etapa: "vincular" };
      }
      // Intenção expirada/inválida: pede intenção nova e repete UMA vez.
      if ((vinc.code === "intencao_expirada" || vinc.code === "intencao_invalida") && tentativa === 0) continue;
      return erroReal(vinc, "vincular");
    }
    return { ok: false, erro: "falha_vinculo", etapa: "vincular" };
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

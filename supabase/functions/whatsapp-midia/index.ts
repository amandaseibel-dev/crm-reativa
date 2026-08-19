// Edge Function: whatsapp-midia
// -----------------------------------------------------------------------------
// Recebe o arquivo que o gateway baixou do WhatsApp e o grava no bucket privado.
//
// POR QUE NÃO É O GATEWAY QUE GRAVA: ele não tem credencial de banco, de
// propósito — se a máquina onde ele roda for invadida, o atacante não ganha o
// Supabase. Manter isso vale mais do que economizar um salto de rede. Aqui, no
// servidor, a chave de serviço existe e o upload acontece.
//
// AUTENTICAÇÃO: a mesma do webhook — HMAC-SHA256 sobre `${timestamp}.${corpo}`,
// com janela de 5 minutos. Sem JWT de usuário, porque quem chama é um serviço.
//
// TRÊS CUIDADOS DE SEGURANÇA QUE MUDAM O COMPORTAMENTO:
//
//   1. O MIME é decidido pelos BYTES, não pelo que mandaram dizer. Extensão e
//      cabeçalho são texto que qualquer um escreve; a assinatura do arquivo,
//      não. Um .jpg que na verdade é outra coisa é recusado.
//
//   2. O caminho é IMPREVISÍVEL (aleatório de 16 bytes). Mesmo que o bucket
//      vazasse por engano, não dá para adivinhar o arquivo do aluno seguinte.
//
//   3. Conteúdo binário NUNCA vai para o log. Nem amostra, nem tamanho de
//      buffer com prévia — só metadado.
//
// Deploy:
//   supabase functions deploy whatsapp-midia --project-ref <ref> --no-verify-jwt
//
// Secrets: WHATSAPP_GATEWAY_SEGREDO, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BUCKET = "whatsapp-midia";
const LIMITE_BYTES = 16 * 1024 * 1024; // 16 MB — abaixo do teto do bucket (20)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-gateway-assinatura, x-gateway-timestamp",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonResp = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

function comparaSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function assinaturaConfere(
  corpoBruto: string,
  assinatura: string | null,
  timestamp: string | null,
  segredo: string,
): Promise<boolean> {
  if (!assinatura || !timestamp) return false;
  const idade = Math.abs(Date.now() - Number(timestamp));
  if (!Number.isFinite(idade) || idade > 5 * 60 * 1000) return false;

  const chave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const assinado = await crypto.subtle.sign(
    "HMAC",
    chave,
    new TextEncoder().encode(`${timestamp}.${corpoBruto}`),
  );
  const esperada = Array.from(new Uint8Array(assinado))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return comparaSeguro(assinatura.trim().toLowerCase(), esperada);
}

// -----------------------------------------------------------------------------
// MIME pelos BYTES.
//
// Só o que a Central precisa exibir nesta fase. Se a assinatura não bater com
// nada desta lista, o arquivo não entra — nem com o MIME "certo" no corpo.
// -----------------------------------------------------------------------------
const ASSINATURAS: Array<{ mime: string; bytes: number[]; deslocamento?: number }> = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp", bytes: [0x57, 0x45, 0x42, 0x50], deslocamento: 8 }, // "WEBP" após RIFF
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: "audio/ogg", bytes: [0x4f, 0x67, 0x67, 0x53] },
  { mime: "audio/mpeg", bytes: [0x49, 0x44, 0x33] },
  { mime: "audio/mpeg", bytes: [0xff, 0xfb] },
  { mime: "audio/amr", bytes: [0x23, 0x21, 0x41, 0x4d, 0x52] },
  { mime: "audio/wav", bytes: [0x57, 0x41, 0x56, 0x45], deslocamento: 8 },
  { mime: "audio/mp4", bytes: [0x66, 0x74, 0x79, 0x70], deslocamento: 4 },
];

function mimeReal(dados: Uint8Array): string | null {
  for (const a of ASSINATURAS) {
    const off = a.deslocamento ?? 0;
    if (dados.length < off + a.bytes.length) continue;
    let bate = true;
    for (let i = 0; i < a.bytes.length; i++) {
      if (dados[off + i] !== a.bytes[i]) { bate = false; break; }
    }
    if (bate) return a.mime;
  }
  return null;
}

// Caminho imprevisível: ano/mês para a manutenção humana, nome aleatório para
// que ninguém adivinhe o arquivo do aluno ao lado.
function caminhoNovo(mime: string): string {
  const agora = new Date();
  const ano = agora.getUTCFullYear();
  const mes = String(agora.getUTCMonth() + 1).padStart(2, "0");
  const aleatorio = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const ext = mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  return `${ano}/${mes}/${aleatorio}.${ext}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResp({ erro: "metodo nao suportado" }, 405);

  const segredo = Deno.env.get("WHATSAPP_GATEWAY_SEGREDO");
  if (!segredo) return jsonResp({ erro: "segredo nao configurado" }, 500);

  const corpoBruto = await req.text();
  const ok = await assinaturaConfere(
    corpoBruto,
    req.headers.get("x-gateway-assinatura"),
    req.headers.get("x-gateway-timestamp"),
    segredo,
  );
  if (!ok) return jsonResp({ erro: "assinatura invalida" }, 401);

  let corpo: {
    acao?: string;
    wamid?: string;
    conteudo_base64?: string;
    mime?: string;
    nome?: string;
    erro?: string;
  };
  try {
    corpo = JSON.parse(corpoBruto);
  } catch {
    return jsonResp({ erro: "corpo invalido" }, 400);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // ---------------------------------------------------------------------------
  // LIMPAR — drena a fila de remoção que o expurgo de 12 meses deixou.
  //
  // O Storage não aceita DELETE por SQL (gatilho `protect_delete`), então quem
  // remove é quem tem a chave de serviço. Sem isto, o arquivo do aluno ficaria
  // no bucket para sempre depois de a mensagem ser apagada.
  // ---------------------------------------------------------------------------
  if (corpo.acao === "limpar") {
    const { data: pendentes, error } = await admin.rpc("whatsapp_midia_a_remover", {
      p_limite: 100,
    });
    if (error) return jsonResp({ erro: error.message }, 500);

    let removidos = 0;
    let falhas = 0;
    for (const linha of pendentes ?? []) {
      const caminho = (linha as { path: string }).path;
      const { error: erroRemocao } = await admin.storage.from(BUCKET).remove([caminho]);
      await admin.rpc("whatsapp_midia_removida", {
        p_path: caminho,
        p_erro: erroRemocao ? String(erroRemocao.message).slice(0, 300) : null,
      });
      if (erroRemocao) falhas++;
      else removidos++;
    }
    return jsonResp({ ok: true, removidos, falhas });
  }

  // ---------------------------------------------------------------------------
  // FALHA NO DOWNLOAD — o gateway não conseguiu o arquivo.
  //
  // A mensagem JÁ está na Central (ela entra pela fila normal, separada desta).
  // Aqui só marcamos o motivo, para o operador ver que veio anexo e que ele não
  // pôde ser recuperado — em vez de a mensagem parecer vazia.
  // ---------------------------------------------------------------------------
  if (!corpo.conteudo_base64) {
    if (!corpo.wamid) return jsonResp({ erro: "wamid obrigatorio" }, 400);
    const { data, error } = await admin.rpc("whatsapp_midia_registrar", {
      p_wamid: corpo.wamid,
      p_erro: (corpo.erro || "anexo nao pode ser recuperado").slice(0, 300),
    });
    if (error) return jsonResp({ erro: error.message }, 500);
    return jsonResp({ ok: true, registrado: data === true, guardado: false });
  }

  if (!corpo.wamid) return jsonResp({ erro: "wamid obrigatorio" }, 400);

  // --------------------------------------------------------------- bytes
  let dados: Uint8Array;
  try {
    const bin = atob(corpo.conteudo_base64);
    dados = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) dados[i] = bin.charCodeAt(i);
  } catch {
    return jsonResp({ erro: "conteudo_base64 invalido" }, 400);
  }

  if (dados.length === 0) return jsonResp({ erro: "arquivo vazio" }, 400);
  if (dados.length > LIMITE_BYTES) {
    // Não é erro do aluno nem do sistema: é limite nosso. A mensagem fica na
    // Central com o motivo, e o operador olha no celular.
    await admin.rpc("whatsapp_midia_registrar", {
      p_wamid: corpo.wamid,
      p_erro: `anexo acima do limite (${Math.round(dados.length / 1024 / 1024)} MB)`,
    });
    return jsonResp({ ok: true, guardado: false, motivo: "acima do limite" });
  }

  // MIME pelos BYTES. O que veio no corpo é só uma dica, e uma dica não decide
  // o que entra no bucket.
  const mime = mimeReal(dados);
  if (!mime) {
    await admin.rpc("whatsapp_midia_registrar", {
      p_wamid: corpo.wamid,
      p_erro: "tipo de arquivo nao suportado nesta fase",
    });
    return jsonResp({ ok: true, guardado: false, motivo: "tipo nao reconhecido" });
  }

  const caminho = caminhoNovo(mime);
  const { error: erroUpload } = await admin.storage.from(BUCKET).upload(caminho, dados, {
    contentType: mime,
    upsert: false,
  });

  if (erroUpload) {
    await admin.rpc("whatsapp_midia_registrar", {
      p_wamid: corpo.wamid,
      p_erro: `falha ao guardar: ${String(erroUpload.message).slice(0, 200)}`,
    });
    return jsonResp({ erro: erroUpload.message }, 500);
  }

  const { data: registrou, error: erroRegistro } = await admin.rpc("whatsapp_midia_registrar", {
    p_wamid: corpo.wamid,
    p_path: caminho,
    p_mime: mime,
    p_tamanho: dados.length,
    p_nome: corpo.nome ? String(corpo.nome).slice(0, 200) : null,
    p_erro: null,
  });

  if (erroRegistro) return jsonResp({ erro: erroRegistro.message }, 500);

  // `registrado: false` significa que a mensagem ainda não chegou ao banco — a
  // mídia trafega FORA da fila ordenada, de propósito, para nunca segurar
  // mensagem de texto atrás dela. O gateway tenta de novo.
  return jsonResp({
    ok: true,
    guardado: true,
    registrado: registrou === true,
    path: caminho,
    mime,
    bytes: dados.length,
  });
});

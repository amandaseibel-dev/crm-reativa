// Edge Function: whatsapp-enviar-audio
// -----------------------------------------------------------------------------
// O operador grava um áudio na conversa da Central e ele sai pelo WhatsApp como
// mensagem de voz.
//
// IRMÃ DA `whatsapp-enviar-documento`, com as MESMAS travas: as duas chamam
// `whatsapp_preparar_envio`, e é a RPC que decide canal, dono e cadência. Canal
// pausado ou em "somente respostas" bloqueia o áudio igual bloqueia o texto —
// sem regra nova aqui.
//
// O QUE MUDA EM RELAÇÃO AO PDF, e por quê:
//
//   1. OS BYTES VÃO NO CORPO PARA O GATEWAY, não por URL assinada. O navegador
//      grava em WebM (Chrome) e o bucket não aceita `audio/webm`. Quem converte
//      para OGG/Opus é o gateway, e ele devolve o OGG na resposta. O teto é
//      1 MB — o mesmo de todo corpo da API de controle.
//
//   2. O QUE FICA GUARDADO É O OGG QUE O ALUNO RECEBEU, não o rascunho. Por isso
//      o upload vem DEPOIS do envio. Envio que falha fica registrado como
//      FALHOU, sem arquivo: o operador grava de novo.
//
//   3. SESSÃO E TELEFONE VÃO EM CABEÇALHO, nunca na URL.
//
// O QUE NÃO MUDA:
//   - o tipo é decidido pelos BYTES (`_shared/audio.ts`);
//   - valida ANTES de preparar o envio, porque `whatsapp_preparar_envio` tem
//     efeito (assume a conversa e consome cadência);
//   - o número de saída não vem do frontend;
//   - falha de envio vira mensagem `FALHOU`, nunca `ENVIADO`;
//   - nenhuma URL pública: o banco guarda o CAMINHO.
//
// Deploy:
//   supabase functions deploy whatsapp-enviar-audio --project-ref <ref>
//
// Secrets: WHATSAPP_GATEWAY_URL, WHATSAPP_GATEWAY_TOKEN.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  LIMITE_AUDIO_BYTES, MIME_GUARDADO, bytesDeBase64, caminhoNovoAudio, formatoDoAudio, validarAudio,
} from "../_shared/audio.ts";

const BUCKET = "whatsapp-midia";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonResp = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// Mesma lista fechada da `whatsapp-send`.
const MOTIVOS_DE_BLOQUEIO = new Set([
  "MODO_PAUSADO",
  "MODO_SOMENTE_RESPOSTAS",
  "FORA_DA_JANELA",
  "LIMITE_OPERADOR",
  "LIMITE_CANAL",
]);

function aleatorio(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResp({ erro: "metodo nao suportado" }, 405);

  const autorizacao = req.headers.get("Authorization") || "";
  if (!autorizacao) return jsonResp({ erro: "sem autenticacao" }, 401);

  const gatewayUrl = (Deno.env.get("WHATSAPP_GATEWAY_URL") || "").replace(/\/+$/, "");
  const gatewayToken = Deno.env.get("WHATSAPP_GATEWAY_TOKEN");
  if (!gatewayUrl || !gatewayToken) {
    return jsonResp({ erro: "gateway do WhatsApp nao configurado" }, 500);
  }

  let formulario: FormData;
  try {
    formulario = await req.formData();
  } catch {
    return jsonResp({ erro: "corpo invalido - envie multipart/form-data" }, 400);
  }

  const conversaId = String(formulario.get("conversa_id") || "").trim();
  const arquivo = formulario.get("arquivo");
  if (!conversaId) return jsonResp({ erro: "informe conversa_id" }, 400);
  if (!(arquivo instanceof File)) return jsonResp({ erro: "informe o audio" }, 400);

  // Teto ANTES de ler o arquivo inteiro na memória.
  if (arquivo.size > LIMITE_AUDIO_BYTES) {
    return jsonResp(
      { erro: `áudio de ${Math.round(arquivo.size / 1000)} KB — o limite é ${LIMITE_AUDIO_BYTES / 1000} KB (cerca de 2 minutos)` },
      413,
    );
  }

  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  const validacao = validarAudio(bytes);
  if (!validacao.ok) return jsonResp({ erro: validacao.erro }, 400);

  // Cliente COM o JWT do operador: é assim que a RPC sabe quem está falando.
  const comoOperador = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: autorizacao } }, auth: { persistSession: false } },
  );

  const { data: preparo, error: erroPreparo } = await comoOperador.rpc(
    "whatsapp_preparar_envio",
    { p_conversa_id: conversaId },
  );

  if (erroPreparo) {
    const motivo = (erroPreparo as { details?: string }).details;
    if (motivo && MOTIVOS_DE_BLOQUEIO.has(motivo)) {
      // `.then` com dois argumentos, não `.catch`: o retorno de `.rpc()` é
      // thenable, não Promise, e `.catch` nele não existe.
      await comoOperador
        .rpc("whatsapp_cadencia_registrar_bloqueio", {
          p_canal_id: null,
          p_conversa_id: conversaId,
          p_motivo: motivo,
        })
        .then(() => {}, () => {});
    }
    return jsonResp({ erro: erroPreparo.message }, 403);
  }

  const dados = Array.isArray(preparo) ? preparo[0] : preparo;
  if (!dados?.sessao_chave) return jsonResp({ erro: "conversa sem canal valido" }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Mensagem + metadados do anexo, pelas mesmas duas RPCs do documento.
  // `caminho` nulo = não há cópia guardada (envio falhou, ou o upload falhou).
  const registrar = async (
    status: string,
    wamid: string | null,
    erro: string | null,
    caminho: string | null,
    tamanho: number | null,
  ) => {
    const chave = wamid ?? `falha:${conversaId}:${Date.now()}`;
    await admin.rpc("whatsapp_registrar_mensagem", {
      p_sessao_chave: dados.sessao_chave,
      p_telefone: dados.telefone_e164,
      p_nome_perfil: null,
      p_wamid: chave,
      p_direcao: "SAIDA",
      p_tipo: "audio_voz",
      p_texto: null,
      p_midia_id: null,
      p_midia_mime: MIME_GUARDADO,
      p_timestamp: new Date().toISOString(),
      p_payload: erro ? { erro } : null,
      p_origem: "TEMPO_REAL",
      p_enviado_por: dados.operador_email,
      p_status: status,
    });
    await admin.rpc("whatsapp_midia_registrar", {
      p_wamid: chave,
      p_path: caminho,
      p_mime: MIME_GUARDADO,
      p_tamanho: tamanho,
      p_nome: "audio.ogg",
      p_erro: erro,
    });
  };

  try {
    const resposta = await fetch(`${gatewayUrl}/enviar-audio`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        authorization: `Bearer ${gatewayToken}`,
        "x-sessao": dados.sessao_chave,
        "x-telefone": dados.telefone_e164,
      },
      body: bytes,
      // Há conversão do lado do gateway antes de o WhatsApp aceitar.
      signal: AbortSignal.timeout(60_000),
    });

    const resultado = await resposta.json().catch(() => ({}));

    if (!resposta.ok || !resultado?.ok) {
      const detalhe = resultado?.erro || `gateway respondeu ${resposta.status}`;
      await registrar("FALHOU", null, `áudio não enviado: ${detalhe}`, null, null);
      return jsonResp({ erro: detalhe, conversa_id: conversaId }, 502);
    }

    // A MENSAGEM JÁ SAIU. Daqui para baixo, nada pode transformar isso em
    // "falhou": se a cópia não for guardada, o registro continua ENVIADO e a
    // observação diz que o áudio não ficou disponível para ouvir depois.
    const ogg = bytesDeBase64(resultado.ogg_base64);
    let caminho: string | null = null;
    let aviso: string | null = null;

    if (ogg && formatoDoAudio(ogg) === "ogg") {
      const destino = caminhoNovoAudio(aleatorio());
      // try próprio: uma exceção aqui cairia no `catch` de baixo e registraria
      // FALHOU para uma mensagem que o aluno já recebeu.
      try {
        const { error: erroUpload } = await admin.storage
          .from(BUCKET)
          .upload(destino, ogg, { contentType: MIME_GUARDADO, upsert: false });
        if (erroUpload) aviso = "áudio enviado, mas a cópia não foi guardada";
        else caminho = destino;
      } catch {
        aviso = "áudio enviado, mas a cópia não foi guardada";
      }
    } else {
      aviso = "áudio enviado, mas a cópia não foi guardada";
    }

    await registrar("ENVIADO", resultado.wamid ?? null, aviso, caminho, caminho ? ogg!.length : null);
    return jsonResp({
      ok: true,
      wamid: resultado.wamid ?? null,
      conversa_id: conversaId,
      segundos: resultado.segundos ?? null,
      aviso,
    });
  } catch (erro) {
    const detalhe = String((erro as Error)?.message || erro);
    await registrar("FALHOU", null, `áudio não enviado: ${detalhe}`, null, null);
    return jsonResp(
      { erro: `nao foi possivel falar com o WhatsApp: ${detalhe}`, conversa_id: conversaId },
      502,
    );
  }
});

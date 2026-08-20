// Edge Function: whatsapp-enviar-documento
// -----------------------------------------------------------------------------
// O operador anexa um PDF na conversa da Central e ele sai pelo WhatsApp.
//
// POR QUE UMA FUNÇÃO NOVA E NÃO UM RAMO DENTRO DA `whatsapp-send`: aquela
// função é o caminho do texto, que é o que a operação usa o dia inteiro. Um
// `if` para arquivo lá dentro colocaria upload, validação de bytes e Storage no
// meio do envio de texto — mais superfície para o caminho que não pode quebrar.
// As TRAVAS, no entanto, são exatamente as mesmas: as duas chamam
// `whatsapp_preparar_envio`, e é a RPC que decide canal, dono e cadência.
//
// O QUE ESTA FUNÇÃO GARANTE, na ordem em que importa:
//
//   1. O TIPO É DECIDIDO PELOS BYTES. Extensão e `file.type` vêm do navegador —
//      texto que qualquer um escreve. Um executável renomeado para .pdf morre
//      aqui, antes de existir no bucket. Ver `_shared/pdf.ts`.
//
//   2. VALIDA ANTES DE PREPARAR O ENVIO. `whatsapp_preparar_envio` tem efeito:
//      assume a conversa para quem responde e consome cadência. Rodar isso para
//      um arquivo que vai ser recusado deixaria o operador como responsável de
//      um atendimento que ele não conseguiu fazer.
//
//   3. O NÚMERO DE SAÍDA NÃO VEM DO FRONTEND. Igual ao texto: a função recebe
//      `conversa_id` e pergunta ao banco por qual canal responder.
//
//   4. FALHA DE ENVIO VIRA MENSAGEM `FALHOU`, NUNCA `ENVIADO`. O arquivo fica
//      anexado a essa mensagem de propósito: o operador precisa ver o que ele
//      tentou mandar para decidir se reenvia.
//
//   5. NENHUMA URL PÚBLICA, NUNCA. O bucket é privado; o gateway recebe uma URL
//      ASSINADA de vida curta só para buscar os bytes, e o banco guarda o
//      CAMINHO — nunca uma URL. Quem vê o anexo depois pede outra URL assinada
//      na hora do clique, como já acontece com a mídia que entra.
//
// Deploy:
//   supabase functions deploy whatsapp-enviar-documento --project-ref <ref>
//
// Secrets: WHATSAPP_GATEWAY_URL, WHATSAPP_GATEWAY_TOKEN.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { LIMITE_BYTES, caminhoNovo, validarPdf } from "../_shared/pdf.ts";

const BUCKET = "whatsapp-midia";

// Vida da URL que o gateway usa para buscar o arquivo. Curta de propósito: ela
// só precisa sobreviver ao download que acontece em seguida.
const VALIDADE_URL_SEG = 120;

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

// Mesma lista fechada da `whatsapp-send`: só se registra bloqueio que se
// reconhece, para o log não virar depósito de qualquer erro que passe por aqui.
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

  // multipart, não base64: o arquivo viaja como bytes. Base64 cresceria ~33% e
  // um PDF de 16 MB viraria um corpo de 21 MB de texto.
  let formulario: FormData;
  try {
    formulario = await req.formData();
  } catch {
    return jsonResp({ erro: "corpo invalido - envie multipart/form-data" }, 400);
  }

  const conversaId = String(formulario.get("conversa_id") || "").trim();
  const arquivo = formulario.get("arquivo");
  if (!conversaId) return jsonResp({ erro: "informe conversa_id" }, 400);
  if (!(arquivo instanceof File)) return jsonResp({ erro: "informe o arquivo" }, 400);

  // Teto ANTES de ler o arquivo inteiro na memória.
  if (arquivo.size > LIMITE_BYTES) {
    const mb = (arquivo.size / 1024 / 1024).toFixed(1);
    return jsonResp(
      { erro: `arquivo de ${mb} MB — o limite é ${LIMITE_BYTES / 1024 / 1024} MB` },
      413,
    );
  }

  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  const validacao = validarPdf(arquivo.name, bytes);
  if (!validacao.ok) return jsonResp({ erro: validacao.erro }, 400);

  // Cliente COM o JWT do operador: é assim que a RPC sabe quem está falando.
  const comoOperador = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: autorizacao } }, auth: { persistSession: false } },
  );

  // Canal, dono e cadência — as MESMAS travas do envio de texto, na mesma RPC.
  // É isto que mantém o Comercial pausado bloqueado sem regra nova aqui.
  const { data: preparo, error: erroPreparo } = await comoOperador.rpc(
    "whatsapp_preparar_envio",
    { p_conversa_id: conversaId },
  );

  if (erroPreparo) {
    const motivo = (erroPreparo as { details?: string }).details;
    if (motivo && MOTIVOS_DE_BLOQUEIO.has(motivo)) {
      await comoOperador
        .rpc("whatsapp_cadencia_registrar_bloqueio", {
          p_canal_id: null,
          p_conversa_id: conversaId,
          p_motivo: motivo,
        })
        .catch(() => {});
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

  // Upload com a chave de serviço. O bucket não tem policy de INSERT para
  // `authenticated` — de propósito: o navegador nunca escreve nele.
  const caminho = caminhoNovo(aleatorio());
  const { error: erroUpload } = await admin.storage
    .from(BUCKET)
    .upload(caminho, bytes, { contentType: validacao.mime, upsert: false });

  if (erroUpload) {
    return jsonResp({ erro: `nao foi possivel guardar o arquivo: ${erroUpload.message}` }, 500);
  }

  // Registra a mensagem e, logo depois, os metadados do anexo. São duas
  // chamadas porque `whatsapp_registrar_mensagem` não recebe nome/tamanho:
  // quem grava isso é `whatsapp_midia_registrar`, a mesma RPC que a mídia de
  // ENTRADA já usa. Reaproveitar evita uma terceira forma de escrever a mesma
  // coisa — e ela acha a mensagem pelo wamid, inclusive o sintético da falha.
  const registrar = async (status: string, wamid: string | null, erro: string | null) => {
    const chave = wamid ?? `falha:${conversaId}:${Date.now()}`;
    await admin.rpc("whatsapp_registrar_mensagem", {
      p_sessao_chave: dados.sessao_chave,
      p_telefone: dados.telefone_e164,
      p_nome_perfil: null,
      p_wamid: chave,
      p_direcao: "SAIDA",
      p_tipo: "document",
      p_texto: null,
      p_midia_id: null,
      p_midia_mime: validacao.mime,
      p_timestamp: new Date().toISOString(),
      p_payload: erro ? { erro } : null,
      p_origem: "TEMPO_REAL",
      p_enviado_por: dados.operador_email,
      p_status: status,
    });
    await admin.rpc("whatsapp_midia_registrar", {
      p_wamid: chave,
      p_path: caminho,
      p_mime: validacao.mime,
      p_tamanho: validacao.tamanho,
      p_nome: validacao.nome,
      p_erro: erro,
    });
  };

  // URL assinada só para o gateway buscar os bytes. Ela não é guardada em lugar
  // nenhum: o banco fica com o CAMINHO.
  const { data: assinada, error: erroAssinatura } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(caminho, VALIDADE_URL_SEG);

  if (erroAssinatura || !assinada?.signedUrl) {
    await registrar("FALHOU", null, "nao foi possivel liberar o arquivo para envio");
    return jsonResp({ erro: "nao foi possivel liberar o arquivo para envio" }, 500);
  }

  try {
    const resposta = await fetch(`${gatewayUrl}/enviar-documento`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify({
        sessao: dados.sessao_chave,
        telefone: dados.telefone_e164,
        url: assinada.signedUrl,
        nome: validacao.nome,
        mime: validacao.mime,
        limite_bytes: LIMITE_BYTES,
      }),
      // Mais folgado que o texto: aqui há download do arquivo do lado do
      // gateway antes de o WhatsApp aceitar.
      signal: AbortSignal.timeout(60_000),
    });

    const resultado = await resposta.json().catch(() => ({}));

    if (!resposta.ok || !resultado?.ok) {
      const detalhe = resultado?.erro || `gateway respondeu ${resposta.status}`;
      await registrar("FALHOU", null, detalhe);
      return jsonResp({ erro: detalhe, conversa_id: conversaId }, 502);
    }

    await registrar("ENVIADO", resultado.wamid ?? null, null);
    return jsonResp({
      ok: true,
      wamid: resultado.wamid ?? null,
      conversa_id: conversaId,
      nome: validacao.nome,
      tamanho: validacao.tamanho,
      mime: validacao.mime,
    });
  } catch (erro) {
    const detalhe = String((erro as Error)?.message || erro);
    await registrar("FALHOU", null, detalhe);
    return jsonResp(
      { erro: `nao foi possivel falar com o WhatsApp: ${detalhe}`, conversa_id: conversaId },
      502,
    );
  }
});

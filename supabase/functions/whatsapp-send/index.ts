// Edge Function: whatsapp-send
// -----------------------------------------------------------------------------
// Envia a resposta do operador pelo espelho na VPS.
//
// POR QUE ISTO É UMA FUNÇÃO E NÃO UMA CHAMADA DIRETA DO NAVEGADOR: o token de
// comando do gateway jamais pode chegar ao frontend. Ele mora no secret
// WHATSAPP_GATEWAY_TOKEN e só é lido aqui, no servidor.
//
// TRÊS DECISÕES QUE PROTEGEM A INTEGRIDADE:
//
// 1) O NÚMERO DE SAÍDA NÃO VEM DO FRONTEND. A função recebe apenas o
//    `conversa_id` e pergunta ao banco (RPC whatsapp_preparar_envio) por qual
//    canal responder. Se o frontend pudesse escolher, um bug responderia pelo
//    número errado — e o aluno receberia resposta de um número que ele nunca
//    procurou.
//
// 2) A TRAVA DE RESPONSÁVEL É NO BANCO, não na tela. A mesma RPC recusa o envio
//    se a conversa está com outro operador, e assume a conversa para quem
//    responde quando ela está livre. É o que impede dois operadores mandarem
//    resposta ao mesmo aluno ao mesmo tempo.
//
// 3) FALHA DE ENVIO É REGISTRADA COMO MENSAGEM `FALHOU`. Isso mantém a conversa
//    na fila de "sem retorno" — se a tentativa sumisse, um erro de envio
//    esconderia a pessoa da fila e ninguém notaria que ela ficou sem resposta.
//
// Não existe mais regra de janela de 24h nem de template: aquilo era tarifação
// da Cloud API da Meta e não se aplica ao caminho por QR Code.
//
// Autorização: exige JWT do operador (COM verify_jwt, ao contrário do webhook).
// A identidade sai do token, nunca do corpo do pedido.
//
// Deploy:
//   supabase functions deploy whatsapp-send --project-ref ahattpqrjmhkzsmnbdzs
//
// Secrets: WHATSAPP_GATEWAY_URL, WHATSAPP_GATEWAY_TOKEN.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const LIMITE_TEXTO = 4096;

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

  let corpo: { conversa_id?: string; texto?: string };
  try {
    corpo = await req.json();
  } catch {
    return jsonResp({ erro: "corpo invalido" }, 400);
  }

  const texto = String(corpo.texto ?? "").trim();
  if (!corpo.conversa_id) return jsonResp({ erro: "conversa_id obrigatorio" }, 400);
  if (!texto) return jsonResp({ erro: "mensagem vazia" }, 400);
  if (texto.length > LIMITE_TEXTO) {
    return jsonResp({ erro: `mensagem acima de ${LIMITE_TEXTO} caracteres` }, 400);
  }

  // Cliente COM o JWT do operador: é assim que a RPC sabe quem está falando.
  const comoOperador = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: autorizacao } }, auth: { persistSession: false } },
  );

  const { data: preparo, error: erroPreparo } = await comoOperador
    .rpc("whatsapp_preparar_envio", { p_conversa_id: corpo.conversa_id });

  if (erroPreparo) return jsonResp({ erro: erroPreparo.message }, 403);

  const dados = Array.isArray(preparo) ? preparo[0] : preparo;
  if (!dados?.sessao_chave) return jsonResp({ erro: "conversa sem canal valido" }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const registrar = (status: string, wamid: string | null, erro: string | null) =>
    admin.rpc("whatsapp_registrar_mensagem", {
      p_sessao_chave: dados.sessao_chave,
      p_telefone: dados.telefone_e164,
      p_nome_perfil: null,
      // Sem id do WhatsApp (envio que falhou) o registro precisa de uma chave
      // própria, senão duas falhas colidiriam na trava de idempotência.
      p_wamid: wamid ?? `falha:${corpo.conversa_id}:${Date.now()}`,
      p_direcao: "SAIDA",
      p_tipo: "text",
      p_texto: texto,
      p_midia_id: null,
      p_midia_mime: null,
      p_timestamp: new Date().toISOString(),
      p_payload: erro ? { erro } : null,
      p_origem: "TEMPO_REAL",
      p_enviado_por: dados.operador_email,
      p_status: status,
    });

  try {
    const resposta = await fetch(`${gatewayUrl}/enviar`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify({
        sessao: dados.sessao_chave,
        telefone: dados.telefone_e164,
        texto,
      }),
      signal: AbortSignal.timeout(25_000),
    });

    const resultado = await resposta.json().catch(() => ({}));

    if (!resposta.ok || !resultado?.ok) {
      const detalhe = resultado?.erro || `gateway respondeu ${resposta.status}`;
      await registrar("FALHOU", null, detalhe);
      return jsonResp({ erro: detalhe }, 502);
    }

    await registrar("ENVIADO", resultado.wamid ?? null, null);
    return jsonResp({ ok: true, wamid: resultado.wamid ?? null });
  } catch (erro) {
    const detalhe = String((erro as Error)?.message || erro);
    // Gateway inalcançável (VPS fora, proxy caído, timeout). Registra a falha
    // para a conversa continuar aparecendo como sem retorno.
    await registrar("FALHOU", null, detalhe);
    return jsonResp({ erro: `nao foi possivel falar com o WhatsApp: ${detalhe}` }, 502);
  }
});

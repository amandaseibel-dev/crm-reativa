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
// DOIS CAMINHOS DE ENTRADA, MESMAS TRAVAS:
//
//   { conversa_id, texto }          -> responder conversa que já existe
//   { canal_id, telefone, texto }   -> INICIAR conversa (o operador procura a
//                                      pessoa e escreve primeiro)
//
// O segundo caminho existe porque, sem ele, iniciar contato obrigava o operador
// a sair para o celular ou para o WhatsApp Web — e o que sai por fora não tem
// histórico na Central, não tem responsável e não aparece na supervisão.
//
// A conversa só nasce DENTRO do envio (RPC whatsapp_preparar_envio_novo). Se
// nascesse ao abrir o formulário, todo operador que desistisse no meio deixaria
// conversa vazia na caixa de entrada. E como a falha também é registrada (ver
// item 3), a conversa nunca fica muda: ou tem a mensagem, ou tem o erro.
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

// Códigos que a cadência devolve em `DETAIL`. A lista é fechada de propósito:
// só registra o que se reconhece, para o log não virar depósito de qualquer
// mensagem de erro que passe por aqui.
const MOTIVOS_DE_BLOQUEIO = new Set([
  "MODO_PAUSADO",
  "MODO_SOMENTE_RESPOSTAS",
  "FORA_DA_JANELA",
  "LIMITE_OPERADOR",
  "LIMITE_CANAL",
]);

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

  let corpo: {
    conversa_id?: string;
    canal_id?: string;
    telefone?: string;
    aluno_id?: string;
    texto?: string;
  };
  try {
    corpo = await req.json();
  } catch {
    return jsonResp({ erro: "corpo invalido" }, 400);
  }

  const texto = String(corpo.texto ?? "").trim();
  const conversaNova = !corpo.conversa_id;

  if (conversaNova && !(corpo.canal_id && corpo.telefone)) {
    return jsonResp({ erro: "informe conversa_id, ou canal_id e telefone" }, 400);
  }
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

  // Qual RPC prepara o envio depende de a conversa já existir. As duas aplicam
  // as MESMAS travas (usuário ativo, canal ativo e conectado, dono da conversa)
  // e as duas decidem o número de saída no banco — nunca aqui.
  const { data: preparo, error: erroPreparo } = conversaNova
    ? await comoOperador.rpc("whatsapp_preparar_envio_novo", {
        p_canal_id: corpo.canal_id,
        p_telefone: corpo.telefone,
        p_aluno_id: corpo.aluno_id ?? null,
      })
    : await comoOperador.rpc("whatsapp_preparar_envio", {
        p_conversa_id: corpo.conversa_id,
      });

  if (erroPreparo) {
    // CADÊNCIA — registro do bloqueio.
    //
    // POR QUE AQUI E NÃO DENTRO DA RPC: a RPC barra levantando exceção, e
    // exceção desfaz a transação inteira — inclusive um log que ela tivesse
    // gravado. O registro precisa de transação separada, e esta é a primeira
    // que existe depois do bloqueio.
    //
    // `details` carrega o código de máquina; `message` continua sendo o texto
    // que o operador lê. Assim não é preciso interpretar frase para saber o
    // motivo.
    //
    // Nada de conteúdo da mensagem e nada de telefone: só canal, operador,
    // referência da conversa, motivo e quando.
    const motivo = (erroPreparo as { details?: string }).details;
    if (motivo && MOTIVOS_DE_BLOQUEIO.has(motivo)) {
      // Falhar o log NÃO pode transformar um bloqueio em erro diferente para o
      // operador: o que importa é que a mensagem não saiu.
      await comoOperador
        .rpc("whatsapp_cadencia_registrar_bloqueio", {
          p_canal_id: corpo.canal_id ?? null,
          p_conversa_id: corpo.conversa_id ?? null,
          p_motivo: motivo,
        })
        .catch(() => {});
    }
    return jsonResp({ erro: erroPreparo.message }, 403);
  }

  const dados = Array.isArray(preparo) ? preparo[0] : preparo;
  if (!dados?.sessao_chave) return jsonResp({ erro: "conversa sem canal valido" }, 400);

  // A tela precisa do id para abrir a conversa recém-criada. Na resposta a uma
  // conversa existente ele já é conhecido, mas devolver sempre mantém o
  // contrato igual nos dois caminhos.
  const conversaId: string = dados.conversa_id ?? corpo.conversa_id!;

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
      p_wamid: wamid ?? `falha:${conversaId}:${Date.now()}`,
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
      return jsonResp({ erro: detalhe, conversa_id: conversaId }, 502);
    }

    await registrar("ENVIADO", resultado.wamid ?? null, null);
    return jsonResp({
      ok: true,
      wamid: resultado.wamid ?? null,
      conversa_id: conversaId,
      ja_existia: dados.ja_existia ?? true,
    });
  } catch (erro) {
    const detalhe = String((erro as Error)?.message || erro);
    // Gateway inalcançável (VPS fora, proxy caído, timeout). Registra a falha
    // para a conversa continuar aparecendo como sem retorno.
    await registrar("FALHOU", null, detalhe);
    return jsonResp(
      { erro: `nao foi possivel falar com o WhatsApp: ${detalhe}`, conversa_id: conversaId },
      502,
    );
  }
});

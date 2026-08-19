// Edge Function: whatsapp-webhook
// -----------------------------------------------------------------------------
// Porta de entrada da Central WhatsApp. Recebe do NOSSO espelho (Node + Baileys
// rodando na VPS) tudo que acontece nos números: mensagem que chega, histórico
// do pareamento, estado da conexão e a credencial da sessão.
//
// POR QUE ESTA FUNÇÃO EXISTE, e não o gateway falando direto com o banco: assim
// o serviço na VPS NÃO precisa de credencial do Supabase. Ele tem um segredo que
// só serve para mandar evento de WhatsApp. Invadir a VPS não vira invadir o CRM.
//
// AUTENTICAÇÃO: HMAC-SHA256 sobre `${timestamp}.${corpo bruto}`, com o segredo
// compartilhado WHATSAPP_GATEWAY_SEGREDO. O timestamp evita repetição de uma
// requisição capturada. Publicada com --no-verify-jwt (o gateway não tem JWT de
// usuário); a assinatura faz o papel da autenticação.
//
// Deploy (o config.toml do repo aponta para STAGING — passe o ref sempre):
//   supabase functions deploy whatsapp-webhook \
//     --project-ref ahattpqrjmhkzsmnbdzs --no-verify-jwt
//
// Secrets: WHATSAPP_GATEWAY_SEGREDO.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const jsonResp = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Diferença de tempo entre duas comparações vazaria informação sobre o segredo.
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

  // Janela de 5 minutos: uma requisição capturada não pode ser reenviada dias
  // depois. O relógio da VPS e o do Supabase são ambos NTP.
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

// Ações que carregam CREDENCIAL da sessão. Nunca vão para o log bruto: quem tem
// esse conteúdo tem o WhatsApp da empresa.
const ACOES_SIGILOSAS = new Set(["estado.ler", "estado.gravar", "estado.apagar"]);

Deno.serve(async (req) => {
  if (req.method !== "POST") return jsonResp({ erro: "metodo nao suportado" }, 405);

  const segredo = Deno.env.get("WHATSAPP_GATEWAY_SEGREDO");
  if (!segredo) return jsonResp({ erro: "gateway nao configurado" }, 500);

  const corpoBruto = await req.text();
  const ok = await assinaturaConfere(
    corpoBruto,
    req.headers.get("x-gateway-assinatura"),
    req.headers.get("x-gateway-timestamp"),
    segredo,
  );
  if (!ok) return jsonResp({ erro: "assinatura invalida" }, 401);

  let evento: { acao?: string; dados?: Record<string, unknown> };
  try {
    evento = JSON.parse(corpoBruto);
  } catch {
    return jsonResp({ erro: "corpo invalido" }, 400);
  }

  const acao = String(evento.acao || "");
  const d = (evento.dados || {}) as Record<string, any>;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Caixa-preta: guarda o que chegou antes de processar, para auditoria e
  // reprocessamento. Sem credencial e sem conteúdo de credencial.
  let eventoId: number | null = null;
  if (!ACOES_SIGILOSAS.has(acao)) {
    const { data } = await admin
      .from("whatsapp_webhook_eventos")
      .insert({ assinatura_ok: true, payload: evento })
      .select("id")
      .single();
    eventoId = data?.id ?? null;
  }

  const concluir = async (erro: string | null) => {
    if (eventoId === null) return;
    await admin
      .from("whatsapp_webhook_eventos")
      .update({ processado: erro === null, erro })
      .eq("id", eventoId);
  };

  try {
    switch (acao) {
      // ---------------------------------------------------------------------
      // Mensagem: tempo real e histórico usam o MESMO caminho. A diferença é
      // `origem`, e a idempotência por wamid protege os dois.
      // ---------------------------------------------------------------------
      case "mensagem": {
        const { error } = await admin.rpc("whatsapp_registrar_mensagem", {
          p_sessao_chave: d.sessao,
          p_telefone: d.telefone,
          p_nome_perfil: d.nome_perfil ?? null,
          p_wamid: d.wamid ?? null,
          p_direcao: d.direcao,
          p_tipo: d.tipo ?? "text",
          p_texto: d.texto ?? null,
          p_midia_id: d.midia_id ?? null,
          p_midia_mime: d.midia_mime ?? null,
          p_timestamp: d.timestamp ?? new Date().toISOString(),
          p_payload: d.payload ?? null,
          p_origem: d.origem ?? "TEMPO_REAL",
          p_enviado_por: d.enviado_por ?? null,
          p_status: d.status ?? null,
        });
        if (error) throw new Error(error.message);
        break;
      }

      // ---------------------------------------------------------------------
      // Evolução do status de saída, vinda dos acks do WhatsApp.
      //
      // A correlação é EXCLUSIVAMENTE por wamid (que é UNIQUE na tabela). A RPC
      // é quem garante a monotonia: ack atrasado não rebaixa status, e wamid
      // desconhecido devolve null em silêncio — ack chega para mensagem que
      // este processo nunca viu sair (reinício do gateway, envio pelo celular).
      // ---------------------------------------------------------------------
      case "mensagem.status": {
        const { error } = await admin.rpc("whatsapp_mensagem_ack", {
          p_wamid: d.wamid,
          p_status: d.status,
          p_em: d.em ?? new Date().toISOString(),
        });
        if (error) throw new Error(error.message);
        break;
      }

      case "conexao": {
        const { error } = await admin.rpc("whatsapp_conexao_reportar", {
          p_sessao_chave: d.sessao,
          p_status: d.status,
          p_detalhe: d.detalhe ?? null,
          p_qr_code: d.qr_code ?? null,
          p_qr_ttl_seg: d.qr_ttl_seg ?? null,
          p_jid: d.jid ?? null,
        });
        if (error) throw new Error(error.message);
        break;
      }

      case "sync.abrir": {
        const { data, error } = await admin.rpc("whatsapp_sync_abrir", { p_sessao_chave: d.sessao });
        if (error) throw new Error(error.message);
        await concluir(null);
        return jsonResp(data);
      }

      case "sync.contabilizar": {
        const { error } = await admin.rpc("whatsapp_sync_contabilizar", {
          p_sync_id: d.sync_id,
          p_conversas: d.conversas ?? 0,
          p_mensagens: d.mensagens ?? 0,
          p_contatos: d.contatos ?? 0,
          p_lote_final: d.lote_final ?? false,
        });
        if (error) throw new Error(error.message);
        break;
      }

      case "sync.concluir": {
        const { error } = await admin.rpc("whatsapp_sync_concluir", {
          p_sync_id: d.sync_id,
          p_erro: d.erro ?? null,
        });
        if (error) throw new Error(error.message);
        break;
      }

      // ---------------------------------------------------------------------
      // Credencial da sessão. Guardada inteira numa linha; o gateway trata o
      // conteúdo, aqui é opaco de propósito — quanto menos esta função souber
      // sobre o formato, menos ela quebra quando o Baileys mudar.
      // ---------------------------------------------------------------------
      case "estado.ler": {
        const { data, error } = await admin
          .from("whatsapp_sessao_credenciais")
          .select("dado")
          .eq("sessao_chave", d.sessao)
          .eq("tipo", "estado")
          .eq("chave", "completo")
          .maybeSingle();
        if (error) throw new Error(error.message);
        return jsonResp({ estado: data?.dado?.json ?? null });
      }

      case "estado.gravar": {
        const { error } = await admin
          .from("whatsapp_sessao_credenciais")
          .upsert(
            {
              sessao_chave: d.sessao,
              tipo: "estado",
              chave: "completo",
              dado: { json: d.estado },
              atualizado_em: new Date().toISOString(),
            },
            { onConflict: "sessao_chave,tipo,chave" },
          );
        if (error) throw new Error(error.message);
        return jsonResp({ ok: true });
      }

      case "estado.apagar": {
        const { error } = await admin
          .from("whatsapp_sessao_credenciais")
          .delete()
          .eq("sessao_chave", d.sessao);
        if (error) throw new Error(error.message);
        return jsonResp({ ok: true });
      }

      default:
        await concluir(`acao desconhecida: ${acao}`);
        return jsonResp({ erro: `acao desconhecida: ${acao}` }, 400);
    }

    await concluir(null);
    return jsonResp({ ok: true });
  } catch (erro) {
    const detalhe = String((erro as Error)?.message || erro);
    await concluir(detalhe);
    // 500 de propósito: o gateway mantém o evento na fila em disco e tenta de
    // novo. Responder 200 com erro faria a mensagem ser descartada em silêncio.
    return jsonResp({ erro: detalhe }, 500);
  }
});

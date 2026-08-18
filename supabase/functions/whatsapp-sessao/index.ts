// Edge Function: whatsapp-sessao
// -----------------------------------------------------------------------------
// Comandos de conexão da Central: reconectar, desconectar e desvincular um
// número. SOMENTE GESTÃO.
//
// POR QUE SEPARADA DO ENVIO: o público é outro (gestão, não operador) e o
// estrago possível é outro. `logout` desvincula o aparelho — e reparear consome
// a única chance de sincronização inicial daquele número. Isso não pode dividir
// porta com o botão que todo operador aperta o dia inteiro.
//
// Deploy:
//   supabase functions deploy whatsapp-sessao --project-ref ahattpqrjmhkzsmnbdzs
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

const COMANDOS = new Set(["reconectar", "desconectar", "logout"]);

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

  let corpo: { canal_id?: string; comando?: string };
  try {
    corpo = await req.json();
  } catch {
    return jsonResp({ erro: "corpo invalido" }, 400);
  }

  const comando = String(corpo.comando || "");
  if (!COMANDOS.has(comando)) return jsonResp({ erro: `comando invalido: ${comando}` }, 400);
  if (!corpo.canal_id) return jsonResp({ erro: "canal_id obrigatorio" }, 400);

  const comoUsuario = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: autorizacao } }, auth: { persistSession: false } },
  );

  // Portão de gestão no BANCO, não aqui: a mesma função que a tela usa. Assim
  // não existe uma segunda definição de "quem é gestão" para sair de sincronia.
  const { data: ehGestao, error: erroGestao } = await comoUsuario.rpc("usuario_e_gestao");
  if (erroGestao) return jsonResp({ erro: erroGestao.message }, 403);
  if (!ehGestao) return jsonResp({ erro: "somente gestao" }, 403);

  const { data: usuario } = await comoUsuario.auth.getUser();
  const email = usuario?.user?.email ?? null;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: canal, error: erroCanal } = await admin
    .from("whatsapp_canais")
    .select("sessao_chave, apelido")
    .eq("id", corpo.canal_id)
    .maybeSingle();

  if (erroCanal) return jsonResp({ erro: erroCanal.message }, 500);
  if (!canal) return jsonResp({ erro: "canal inexistente" }, 404);

  // Registra ANTES de executar: se o comando derrubar a sessão, o rastro de
  // quem mandou já está gravado.
  await admin.from("whatsapp_conexao_eventos").insert({
    canal_id: corpo.canal_id,
    sessao_chave: canal.sessao_chave,
    evento: "COMANDO",
    detalhe: comando,
    por_email: email,
  });

  try {
    const resposta = await fetch(`${gatewayUrl}/sessao/${canal.sessao_chave}/${comando}`, {
      method: "POST",
      headers: { authorization: `Bearer ${gatewayToken}` },
      signal: AbortSignal.timeout(25_000),
    });
    const resultado = await resposta.json().catch(() => ({}));

    if (!resposta.ok) {
      return jsonResp({ erro: resultado?.erro || `gateway respondeu ${resposta.status}` }, 502);
    }
    return jsonResp({ ok: true, estado: resultado?.estado ?? null });
  } catch (erro) {
    return jsonResp(
      { erro: `nao foi possivel falar com o servidor do WhatsApp: ${String((erro as Error)?.message || erro)}` },
      502,
    );
  }
});

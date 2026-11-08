// SUPERADA PELA `ulbra-sincronizar` (08/11/2026). NAO USAR EM TELA NOVA.
// -----------------------------------------------------------------------------
// Esta funcao faz UMA chamada a Mensageria POR REQUISICAO, e foi desenhada
// para ser chamada pela aba de cada operador a cada 60s -- 1.440 chamadas por
// dia POR PESSOA, contra um teto medido de 500/dia para a credencial inteira.
// Nunca foi montada em tela nenhuma, e e por isso que o orcamento nunca
// estourou. O caminho novo e: `ulbra-sincronizar` (um cron, uma credencial)
// grava o espelho no banco, e a tela le o banco.
//
// Continua publicada e intocada de proposito: remover funcao publicada e
// passo com autorizacao propria, nao efeito colateral desta entrega.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decidirAcessoLeads } from "./portao.ts";
import { MCP_URL, extrairResultado, mapearLeads, montarChamada } from "./leads.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function responder(corpo: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const decisao = await decidirAcessoLeads({
    autorizacao: req.headers.get("authorization") ?? "",
    obterUsuario: async (auth) => {
      // Tudo com o JWT da pessoa: a RLS de usuarios e usuario_e_gestao()
      // decidem pela identidade do token, nunca por uma linha arbitrária.
      const sb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: auth } } }
      );
      const { data: { user } } = await sb.auth.getUser();
      if (!user?.email) return null;

      const { data: usuario } = await sb
        .from("usuarios")
        .select("receptivo")
        .ilike("email", user.email)
        .eq("ativo", true)
        .limit(1)
        .maybeSingle();
      if (!usuario) return null;

      const { data: gestao, error } = await sb.rpc("usuario_e_gestao");
      if (error) console.error("ulbra-leads-pendentes: usuario_e_gestao falhou", error.message);

      return { receptivo: usuario.receptivo === true, gestao: gestao === true };
    },
  });

  if (!decisao.ok) return responder(decisao.corpo, decisao.status);

  const token = Deno.env.get("ULBRA_MCP_TOKEN");
  if (!token) {
    console.error("ulbra-leads-pendentes: ULBRA_MCP_TOKEN ausente no ambiente da função");
    return responder({ erro: "CONFIG_AUSENTE" }, 500);
  }

  try {
    const resp = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(montarChamada()),
    });
    if (!resp.ok) {
      console.error("ulbra-leads-pendentes: MCP respondeu", resp.status);
      return responder({ erro: resp.status === 429 ? "ULBRA_LIMITE" : "ULBRA_INDISPONIVEL" }, 502);
    }
    return responder({ leads: mapearLeads(extrairResultado(await resp.json())) });
  } catch (e) {
    console.error("ulbra-leads-pendentes: falha ao consultar MCP", (e as Error).name);
    return responder({ erro: "ULBRA_INDISPONIVEL" }, 502);
  }
});

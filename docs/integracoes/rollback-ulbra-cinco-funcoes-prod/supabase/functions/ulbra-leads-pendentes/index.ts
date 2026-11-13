import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MCP_URL = "https://crm.ulbra.ai/api/mcp";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ erro: "SEM_TOKEN" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: usuario } = await sb
    .from("usuarios")
    .select("receptivo, gestao")
    .limit(1)
    .single();

  if (!usuario) {
    return new Response(JSON.stringify({ erro: "ACESSO_NEGADO" }), {
      status: 403,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const temAcesso = usuario.receptivo || usuario.gestao;
  if (!temAcesso) {
    return new Response(
      JSON.stringify({ leads: [], motivo: "NAO_RECEPTIVO" }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }

  const token = Deno.env.get("ULBRA_MCP_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ erro: "CONFIG_AUSENTE" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "listar_atendimentos",
        arguments: { situacao: "waiting" },
      },
    }),
  });

  if (!resp.ok) {
    return new Response(JSON.stringify({ erro: "ULBRA_INDISPONIVEL" }), {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const json = await resp.json() as {
    result?: { content?: Array<{ text?: string }> };
  };
  const text = json?.result?.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text) as {
    atendimentos?: Array<{
      id: string;
      equipe?: string | null;
      cliente?: { nome?: string };
      criadoEm?: string;
      updatedAt?: string;
    }>;
  };

  const emEscopo = (parsed.atendimentos ?? []).filter((a) => a.equipe === "Reativa");

  const leads = emEscopo.map((a) => ({
    id: a.id,
    nome: a.cliente?.nome ?? "Sem nome",
    criado_em: a.criadoEm ?? a.updatedAt ?? null,
  }));

  return new Response(JSON.stringify({ leads }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
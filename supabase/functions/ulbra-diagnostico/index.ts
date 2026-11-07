// Diagnóstico de gestão: diz o que o TOKEN DE BACKEND pode fazer na
// Mensageria. Existe porque o escopo do `ULBRA_MCP_TOKEN` não é visível de
// fora — o valor do secret não é exibível no painel — e ele decide o desenho
// da integração operacional.
//
// Só leitura: duas chamadas ao MCP, `meu_acesso` e `tools/list`. Devolve
// APENAS superfície — escopos, limites e nomes de ferramentas. Nunca a
// credencial, nunca dado de aluno, nunca conversa, nem o nome ou e-mail do
// dono do token. Não grava nada: sem insert, sem auditoria.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ACCEPT_MCP,
  MCP_URL,
  cargaDaFerramenta,
  lerCorpoMcp,
  recortarAcesso,
  recortarFerramentas,
  resultadoDoEnvelope,
} from "./diagnostico.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Só gestão. Operador e supervisor não têm o que fazer aqui. */
const PERFIS_GESTAO = ["gerencia", "administrativo"];

function responder(corpo: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function chamar(token: string, corpo: Record<string, unknown>) {
  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: ACCEPT_MCP,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(corpo),
  });
  if (!resp.ok) {
    // `resp.status` não carrega segredo; o corpo pode carregar, então fica fora.
    throw new Error(resp.status === 429 ? "ULBRA_LIMITE" : `ULBRA_HTTP_${resp.status}`);
  }
  return resultadoDoEnvelope(
    lerCorpoMcp(resp.headers.get("content-type"), await resp.text()),
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return responder({ erro: "SEM_TOKEN" }, 401);

  const sbUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } },
  );
  const sbService = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: { user } } = await sbUser.auth.getUser();
  if (!user?.email) return responder({ erro: "ACESSO_NEGADO" }, 403);

  const { data: usuario } = await sbService
    .from("usuarios")
    .select("perfil")
    .ilike("email", user.email)
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();

  if (!usuario || !PERFIS_GESTAO.includes(usuario.perfil as string)) {
    return responder({ erro: "ACESSO_NEGADO", detalhe: "somente_gestao" }, 403);
  }

  const token = Deno.env.get("ULBRA_MCP_TOKEN");
  if (!token) return responder({ erro: "CONFIG_AUSENTE" }, 500);

  try {
    const acesso = recortarAcesso(
      cargaDaFerramenta(
        await chamar(token, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "meu_acesso", arguments: {} },
        }),
      ),
    );

    const ferramentas = recortarFerramentas(
      await chamar(token, { jsonrpc: "2.0", id: 2, method: "tools/list" }),
    );

    return responder({ acesso, ferramentas, total_ferramentas: ferramentas.length });
  } catch (e) {
    const motivo = (e as Error).message;
    console.error("ulbra-diagnostico: falha ao consultar MCP", motivo);
    return responder({ erro: "ULBRA_INDISPONIVEL", motivo }, 502);
  }
});

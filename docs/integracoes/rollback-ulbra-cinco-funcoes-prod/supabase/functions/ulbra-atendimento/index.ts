// Atendimento atual do aluno na Mensageria Ulbra, para a ficha.
// Só consulta aluno com vínculo ativo em ulbra_vinculos (criado pela
// ulbra-consultar). Mesmo portão da ulbra-consultar: JWT + usuário ativo;
// operador só vê aluno da própria carteira. Não grava nada.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ACCEPT_MCP, MCP_URL, criarCache, extrairResultado, lerCorpoMcp, montarChamada, recortar, vinculoConfirmado } from "./atendimento.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const PERFIS_AMPLOS = ["supervisor", "gerencia", "administrativo"];
const cache = criarCache();

function responder(corpo: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return responder({ erro: "SEM_TOKEN" }, 401);

  const { aluno_id } = await req.json().catch(() => ({}));
  if (!aluno_id) return responder({ erro: "ALUNO_ID_OBRIGATORIO" }, 400);

  const sbUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } }
  );
  const sbService = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: { user } } = await sbUser.auth.getUser();
  if (!user?.email) return responder({ erro: "ACESSO_NEGADO" }, 403);

  const { data: usuario } = await sbService
    .from("usuarios").select("email, perfil").ilike("email", user.email).eq("ativo", true).limit(1).maybeSingle();
  if (!usuario) return responder({ erro: "ACESSO_NEGADO" }, 403);

  if (!PERFIS_AMPLOS.includes(usuario.perfil as string)) {
    const { data: naCarteira } = await sbService
      .from("alunos").select("id").eq("id", aluno_id).ilike("responsavel_atual_email", usuario.email as string).limit(1).maybeSingle();
    if (!naCarteira) return responder({ erro: "ACESSO_NEGADO", detalhe: "aluno_fora_da_carteira" }, 403);
  }

  const vinculo = await vinculoConfirmado(sbService, aluno_id);
  if (!vinculo) return responder({ status: "sem_vinculo" });

  const clienteId = vinculo.ulbra_cliente_id as string;
  const emCache = cache.obter(clienteId);
  if (emCache !== undefined) return responder({ status: emCache ? "encontrado" : "sem_atendimento", atendimento: emCache, cache: true });

  const token = Deno.env.get("ULBRA_MCP_TOKEN");
  if (!token) {
    console.error("ulbra-atendimento: ULBRA_MCP_TOKEN ausente no ambiente da função");
    return responder({ erro: "CONFIG_AUSENTE" }, 500);
  }

  try {
    const resp = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: ACCEPT_MCP,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(montarChamada(clienteId)),
    });
    if (!resp.ok) {
      console.error("ulbra-atendimento: MCP respondeu", resp.status);
      return responder({ erro: resp.status === 429 ? "ULBRA_LIMITE" : "ULBRA_INDISPONIVEL" }, 502);
    }
    const envelope = lerCorpoMcp(resp.headers.get("content-type"), await resp.text());
    const atendimento = recortar(extrairResultado(envelope));
    cache.guardar(clienteId, atendimento);
    return responder({ status: atendimento ? "encontrado" : "sem_atendimento", atendimento, cache: false });
  } catch (e) {
    console.error("ulbra-atendimento: falha ao consultar MCP", (e as Error).name);
    return responder({ erro: "ULBRA_INDISPONIVEL" }, 502);
  }
});

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decidirAcessoUlbra } from "./portao.ts";

const MCP_URL = "https://crm.ulbra.ai/api/mcp";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const body = await req.json().catch(() => ({}));
  const { aluno_id } = body;

  if (!aluno_id) {
    return new Response(JSON.stringify({ erro: "ALUNO_ID_OBRIGATORIO" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const sbService = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const decisao = await decidirAcessoUlbra({
    autorizacao: req.headers.get("authorization") ?? "",
    aluno_id,

    // Verifica que o JWT pertence a um usuario ativo e retorna email + perfil
    validarOperador: async (auth) => {
      const sb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: auth } } }
      );
      const { data: { user } } = await sb.auth.getUser();
      if (!user?.email) return null;

      // Busca perfil via service_role para evitar RLS na tabela usuarios
      const { data: usuario } = await sbService
        .from("usuarios")
        .select("email, perfil")
        .ilike("email", user.email)
        .eq("ativo", true)
        .limit(1)
        .single();

      if (!usuario) return null;
      return { email: usuario.email as string, perfil: usuario.perfil as string };
    },

    // Para perfil 'operador': confirma que aluno esta na carteira dele
    // (responsavel_atual_email = email do operador, mesma regra do RLS alunos_update)
    verificarEscopoAluno: async (email, _perfil, id) => {
      const { data } = await sbService
        .from("alunos")
        .select("id")
        .eq("id", id)
        .ilike("responsavel_atual_email", email)
        .limit(1)
        .single();
      return !!data;
    },
  });

  if (!decisao.ok) {
    return new Response(JSON.stringify(decisao.corpo), {
      status: decisao.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // A partir daqui o acesso ao aluno esta autorizado

  // Verificar vínculo ativo existente
  const { data: vinculo } = await sbService
    .from("ulbra_vinculos")
    .select("ulbra_cliente_id, confianca, origem")
    .eq("aluno_id", aluno_id)
    .is("desvinculado_em", null)
    .single();

  if (vinculo) {
    return new Response(
      JSON.stringify({
        status: "vinculado",
        ulbra_cliente_id: vinculo.ulbra_cliente_id,
        confianca: vinculo.confianca,
        origem: vinculo.origem,
        url: `https://crm.ulbra.ai/atendimentos/${vinculo.ulbra_cliente_id}`,
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }

  // Buscar telefone do aluno
  const { data: aluno } = await sbService
    .from("alunos")
    .select("telefone, cpf, email")
    .eq("id", aluno_id)
    .single();

  if (!aluno) {
    return new Response(JSON.stringify({ status: "nao_encontrado", motivo: "ALUNO_NAO_ENCONTRADO" }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const token = Deno.env.get("ULBRA_MCP_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ erro: "CONFIG_AUSENTE" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const tel = aluno.telefone?.replace(/\D/g, "");
  const telValido = tel && tel.length >= 10 && tel.length <= 13;

  let busca: { campo: string; valor: string } | null = null;

  if (telValido) {
    busca = { campo: "telefone", valor: tel };
  } else if (aluno.cpf) {
    busca = { campo: "cpf", valor: aluno.cpf.replace(/\D/g, "") };
  } else {
    return new Response(
      JSON.stringify({ status: "nao_encontrado", motivo: telValido ? "SEM_TELEFONE" : "TELEFONE_MALFORMADO" }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }

  // Conferir duplicidade na Mensageria Ulbra
  const dupResp = await fetch(MCP_URL, {
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
        name: "conferir_duplicidade",
        arguments: { [busca.campo]: busca.valor },
      },
    }),
  });

  if (!dupResp.ok) {
    return new Response(JSON.stringify({ erro: "ULBRA_INDISPONIVEL" }), {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const dupJson = await dupResp.json() as {
    result?: { content?: Array<{ text?: string }> };
  };
  const dupText = dupJson?.result?.content?.[0]?.text ?? "{}";
  const dup = JSON.parse(dupText) as {
    clientes?: Array<{ id: string; equipe?: string | null }>;
  };

  const emEscopo = (dup.clientes ?? []).filter((c) => c.equipe != null);

  if (emEscopo.length !== 1) {
    return new Response(
      JSON.stringify({
        status: emEscopo.length === 0 ? "nao_encontrado" : "ambiguo",
        motivo: emEscopo.length === 0 ? "NAO_ENCONTRADO" : "MULTIPLOS_CADASTROS",
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }

  const clienteId = emEscopo[0].id;

  // Consultar dados do cliente confirmado
  const cliResp = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "consultar_cliente", arguments: { id: clienteId } },
    }),
  });

  if (!cliResp.ok) {
    return new Response(JSON.stringify({ erro: "ULBRA_INDISPONIVEL" }), {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Gravar vínculo de alta confiança
  await sbService.from("ulbra_vinculos").insert({
    aluno_id,
    ulbra_cliente_id: clienteId,
    telefone_e164: telValido ? `+55${tel}` : null,
    confianca: "alta",
    origem: busca.campo as "telefone" | "cpf",
    vinculado_por: decisao.usuario.email,
  });

  return new Response(
    JSON.stringify({
      status: "vinculado",
      ulbra_cliente_id: clienteId,
      confianca: "alta",
      origem: busca.campo,
      url: `https://crm.ulbra.ai/atendimentos/${clienteId}`,
    }),
    { headers: { ...CORS, "Content-Type": "application/json" } }
  );
});

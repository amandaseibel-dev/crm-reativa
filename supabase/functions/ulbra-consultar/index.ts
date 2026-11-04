import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decidirAcessoUlbra } from "./portao.ts";
import { MCP_URL, escolherContato, extrairResultado, interpretar, montarChamada } from "./mcp.ts";

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

function urlCliente(clienteId: string) {
  return `https://crm.ulbra.ai/atendimentos/${clienteId}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const body = await req.json().catch(() => ({}));
  const { aluno_id } = body;
  if (!aluno_id) return responder({ erro: "ALUNO_ID_OBRIGATORIO" }, 400);

  const sbService = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const decisao = await decidirAcessoUlbra({
    autorizacao: req.headers.get("authorization") ?? "",
    aluno_id,
    validarOperador: async (auth) => {
      const sb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: auth } } }
      );
      const { data: { user } } = await sb.auth.getUser();
      if (!user?.email) return null;
      const { data: usuario } = await sbService
        .from("usuarios")
        .select("email, perfil")
        .ilike("email", user.email)
        .eq("ativo", true)
        .limit(1)
        .maybeSingle();
      if (!usuario) return null;
      return { email: usuario.email as string, perfil: usuario.perfil as string };
    },
    verificarEscopoAluno: async (email, _perfil, id) => {
      const { data } = await sbService
        .from("alunos")
        .select("id")
        .eq("id", id)
        .ilike("responsavel_atual_email", email)
        .limit(1)
        .maybeSingle();
      return !!data;
    },
  });

  if (!decisao.ok) return responder(decisao.corpo, decisao.status);

  const usuario = decisao.usuario.email;

  // Auditoria: só quem chama a Mensageria ou grava vínculo. Nunca telefone/CPF.
  const auditar = async (
    acao: "ULBRA_CONSULTA" | "ULBRA_VINCULO_CRIADO",
    tabela_afetada: "alunos" | "ulbra_vinculos",
    registro_id: string,
    detalhes: Record<string, unknown>
  ) => {
    const { error } = await sbService
      .from("auditoria")
      .insert({ usuario, acao, tabela_afetada, registro_id, detalhes: { aluno_id, ...detalhes } });
    if (error) console.error("ulbra-consultar: auditoria falhou", acao, error.message);
  };

  const { data: vinculo } = await sbService
    .from("ulbra_vinculos")
    .select("ulbra_cliente_id, confianca, origem")
    .eq("aluno_id", aluno_id)
    .is("desvinculado_em", null)
    .maybeSingle();

  if (vinculo) {
    return responder({
      status: "vinculado",
      ulbra_cliente_id: vinculo.ulbra_cliente_id,
      confianca: vinculo.confianca,
      origem: vinculo.origem,
      url: urlCliente(vinculo.ulbra_cliente_id),
    });
  }

  const { data: aluno } = await sbService
    .from("alunos")
    .select("telefone, cpf")
    .eq("id", aluno_id)
    .maybeSingle();
  if (!aluno) return responder({ status: "nao_encontrado", motivo: "ALUNO_NAO_ENCONTRADO" });

  const token = Deno.env.get("ULBRA_MCP_TOKEN");
  if (!token) {
    console.error("ulbra-consultar: ULBRA_MCP_TOKEN ausente no ambiente da função");
    return responder({ erro: "CONFIG_AUSENTE" }, 500);
  }

  const escolha = escolherContato(aluno);
  if ("erro" in escolha) return responder({ status: "nao_encontrado", motivo: escolha.erro });

  let interpretado;
  try {
    const resp = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(montarChamada(escolha.contato)),
    });
    if (!resp.ok) {
      console.error("ulbra-consultar: MCP respondeu", resp.status);
      await auditar("ULBRA_CONSULTA", "alunos", aluno_id, { origem: escolha.origem, resultado: "ULBRA_INDISPONIVEL", http: resp.status });
      return responder({ erro: resp.status === 429 ? "ULBRA_LIMITE" : "ULBRA_INDISPONIVEL" }, 502);
    }
    interpretado = interpretar(extrairResultado(await resp.json()));
  } catch (e) {
    console.error("ulbra-consultar: falha ao consultar MCP", (e as Error).message);
    await auditar("ULBRA_CONSULTA", "alunos", aluno_id, { origem: escolha.origem, resultado: "ULBRA_INDISPONIVEL" });
    return responder({ erro: "ULBRA_INDISPONIVEL" }, 502);
  }

  if (interpretado.status !== "vinculado") {
    await auditar("ULBRA_CONSULTA", "alunos", aluno_id, { origem: escolha.origem, resultado: interpretado.motivo });
    return responder(interpretado, interpretado.status === "erro" ? 502 : 200);
  }

  const { data: novo, error: erroVinculo } = await sbService
    .from("ulbra_vinculos")
    .insert({
      aluno_id,
      ulbra_cliente_id: interpretado.ulbra_cliente_id,
      telefone_e164: escolha.telefone_e164,
      confianca: "alta",
      origem: escolha.origem,
      vinculado_por: usuario,
    })
    .select("id")
    .single();

  if (erroVinculo || !novo) {
    console.error("ulbra-consultar: falha ao gravar vínculo", erroVinculo?.message);
    await auditar("ULBRA_CONSULTA", "alunos", aluno_id, { origem: escolha.origem, resultado: "VINCULO_NAO_GRAVADO", ulbra_cliente_id: interpretado.ulbra_cliente_id });
    return responder({ erro: "VINCULO_NAO_GRAVADO" }, 500);
  }

  await auditar("ULBRA_VINCULO_CRIADO", "ulbra_vinculos", novo.id, {
    origem: escolha.origem,
    ulbra_cliente_id: interpretado.ulbra_cliente_id,
    equipe: interpretado.equipe,
    em_atendimento: interpretado.em_atendimento,
  });

  return responder({
    status: "vinculado",
    ulbra_cliente_id: interpretado.ulbra_cliente_id,
    confianca: "alta",
    origem: escolha.origem,
    url: urlCliente(interpretado.ulbra_cliente_id),
  });
});

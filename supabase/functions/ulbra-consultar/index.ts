import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { emailNormalizado, unicoAtivo } from "../_shared/email_exato.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decidirAcessoUlbra } from "./portao.ts";
import {
  ACCEPT_MCP,
  MCP_URL,
  contatosDeChaves,
  extrairResultado,
  interpretarPorChave,
  lerCorpoMcp,
  montarChamadaMulti,
  montarChaves,
} from "./mcp.ts";
import { CONFIANCA, decidirVinculo } from "./vinculo.ts";

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

// Rota do CADASTRO do cliente na Mensageria. Conferida em 07/11/2026
// abrindo `/app/clientes/<ulbra_cliente_id>` com um id vindo de
// `conferir_duplicidade`: carrega a ficha do cliente. O formato antigo
// (`/atendimentos/<id>`) devolvia "Not Found" — punha id de CLIENTE numa
// rota de ATENDIMENTO, que tem id proprio.
function urlCliente(clienteId: string) {
  return `https://crm.ulbra.ai/app/clientes/${clienteId}`;
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
      const { data: usuarioLinhas } = await sbService
        .from("usuarios")
        .select("email, perfil")
        .eq("email", emailNormalizado(user.email))
        .eq("ativo", true)
        .limit(2);
  const usuario = unicoAtivo(usuarioLinhas);
      if (!usuario) return null;
      return { email: usuario.email as string, perfil: usuario.perfil as string };
    },
    verificarEscopoAluno: async (email, _perfil, id) => {
      const { data } = await sbService
        .from("alunos")
        .select("id")
        .eq("id", id)
        .eq("responsavel_atual_email", emailNormalizado(email))
        .limit(1)
        .maybeSingle();
      return !!data;
    },
  });

  if (!decisao.ok) return responder(decisao.corpo, decisao.status);

  const usuario = decisao.usuario.email;

  // Auditoria: só quem chama a Mensageria ou grava/barra vínculo.
  // NUNCA telefone nem CPF — só QUAL chave casou, nunca o valor dela.
  const auditar = async (
    acao: "ULBRA_CONSULTA" | "ULBRA_VINCULO_CRIADO" | "ULBRA_VINCULO_BLOQUEADO",
    tabela_afetada: "alunos" | "ulbra_vinculos",
    registro_id: string,
    detalhes: Record<string, unknown>
  ) => {
    const { error } = await sbService
      .from("auditoria")
      .insert({ usuario, acao, tabela_afetada, registro_id, detalhes: { aluno_id, ...detalhes } });
    if (error) console.error("ulbra-consultar: auditoria falhou", acao, error.message);
  };

  // -------------------------------------------------------------------------
  // Vínculo já gravado: devolve e para. Falha FECHADO se a leitura der erro —
  // seguir adiante com `vinculo` nulo por causa de um erro de leitura é como
  // se cria o segundo vínculo ativo do mesmo aluno.
  // -------------------------------------------------------------------------
  const { data: vinculo, error: erroLeitura } = await sbService
    .from("ulbra_vinculos")
    .select("ulbra_cliente_id, confianca, origem, vinculado_em")
    .eq("aluno_id", aluno_id)
    .is("desvinculado_em", null)
    .maybeSingle();

  if (erroLeitura) {
    console.error("ulbra-consultar: falha ao ler vinculo", erroLeitura.message);
    return responder({ erro: "VINCULO_LEITURA_FALHOU" }, 500);
  }

  if (vinculo) {
    const d = await decidirVinculo({
      existente: vinculo,
      clienteJaDeOutroAluno: async () => true,
    });
    if (d.acao !== "manter_existente") {
      // Inalcançável por construção: `existente` é o primeiro portão de
      // decidirVinculo. Fecha em vez de assumir o caminho felizardo.
      console.error("ulbra-consultar: decisao inesperada para vinculo existente", d.acao);
      return responder({ erro: "DECISAO_INESPERADA" }, 500);
    }
    // Vínculo sem CPF comprovado NÃO é atalho para a Mensageria. Aviso não
    // basta: enquanto houver `url` na resposta, existe botão para clicar, e um
    // clique abre o atendimento de um cliente que ninguém confirmou ser este
    // aluno. Então a resposta não carrega `url` NEM `ulbra_cliente_id` — sem o
    // id, nenhum cliente consegue remontar a URL por conta própria.
    // A linha continua na tabela, visível para a gestão; o que sai é o acesso
    // automático pela ficha.
    if (d.reconfirmar_recomendado) {
      // `tabela_afetada: "alunos"` porque `registro_id` é o id do ALUNO, não o
      // da linha de vínculo — mesma forma do outro caminho de bloqueio. Nada
      // em `ulbra_vinculos` é escrito aqui.
      // Esta linha repete a cada abertura da ficha enquanto o vínculo seguir
      // sem confirmação: é recusa de acesso, e recusa repetida é registro
      // legítimo, não erro. Volume é zero hoje (a tabela está vazia).
      await auditar("ULBRA_VINCULO_BLOQUEADO", "alunos", aluno_id, {
        motivo: "VINCULO_SEM_CONFIRMACAO_CPF",
        confianca: d.confianca,
        origem: d.origem,
      });
      return responder({
        status: "vinculado_nao_confirmado",
        confianca: d.confianca,
        origem: d.origem,
        reconfirmar_recomendado: true,
      });
    }

    return responder({
      status: "vinculado",
      ulbra_cliente_id: d.ulbra_cliente_id,
      confianca: d.confianca,
      origem: d.origem,
      reconfirmar_recomendado: false,
      url: urlCliente(d.ulbra_cliente_id),
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

  const montagem = montarChaves(aluno);
  if ("erro" in montagem) {
    const motivo = montagem.erro === "SEM_CHAVE" ? "SEM_TELEFONE" : montagem.erro;
    return responder({ status: "nao_encontrado", motivo });
  }
  const { chaves, ordem } = montagem;

  // Telefone E CPF na MESMA chamada: `contatos` aceita até 20 posições e o
  // limite da Mensageria é por chamada, então a confirmação cruzada é de graça.
  let porChave;
  try {
    const resp = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: ACCEPT_MCP,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(montarChamadaMulti(contatosDeChaves(chaves, ordem))),
    });
    if (!resp.ok) {
      console.error("ulbra-consultar: MCP respondeu", resp.status);
      await auditar("ULBRA_CONSULTA", "alunos", aluno_id, { chaves: ordem, resultado: "ULBRA_INDISPONIVEL", http: resp.status });
      return responder({ erro: resp.status === 429 ? "ULBRA_LIMITE" : "ULBRA_INDISPONIVEL" }, 502);
    }
    const envelope = lerCorpoMcp(resp.headers.get("content-type"), await resp.text());
    const lido = interpretarPorChave(extrairResultado(envelope), ordem);
    if (!lido.ok) {
      await auditar("ULBRA_CONSULTA", "alunos", aluno_id, { chaves: ordem, resultado: lido.motivo });
      return responder({ status: "erro", motivo: lido.motivo }, 502);
    }
    porChave = lido.porChave;
  } catch (e) {
    console.error("ulbra-consultar: falha ao consultar MCP", (e as Error).name);
    await auditar("ULBRA_CONSULTA", "alunos", aluno_id, { chaves: ordem, resultado: "ULBRA_INDISPONIVEL" });
    return responder({ erro: "ULBRA_INDISPONIVEL" }, 502);
  }

  const achado = (k: "telefone" | "cpf") => {
    const i = porChave[k];
    if (!i) return undefined;
    return {
      ulbra_cliente_id: i.status === "vinculado" ? i.ulbra_cliente_id : null,
      equipe: i.status === "vinculado" ? i.equipe : null,
      em_atendimento: i.status === "vinculado" ? i.em_atendimento : false,
      fora_do_escopo: i.status === "nao_encontrado" && i.motivo === "FORA_DO_ESCOPO",
    };
  };

  const d = await decidirVinculo({
    existente: null,
    porTelefone: achado("telefone"),
    porCpf: achado("cpf"),
    telefone_e164: chaves.telefone_e164 ?? null,
    clienteJaDeOutroAluno: async (clienteId) => {
      const { data, error } = await sbService
        .from("ulbra_vinculos")
        .select("aluno_id")
        .eq("ulbra_cliente_id", clienteId)
        .is("desvinculado_em", null)
        .neq("aluno_id", aluno_id)
        .limit(1)
        .maybeSingle();
      // Erro de leitura NÃO é "não existe": falha fechado tratando como
      // duplicado, que barra o vínculo em vez de criar o errado.
      if (error) {
        console.error("ulbra-consultar: falha ao checar cliente duplicado", error.message);
        return true;
      }
      return !!data;
    },
  });

  if (d.acao === "nao_encontrado") {
    await auditar("ULBRA_CONSULTA", "alunos", aluno_id, { chaves: ordem, resultado: d.motivo });
    return responder({ status: "nao_encontrado", motivo: d.motivo });
  }

  if (d.acao === "bloquear") {
    await auditar("ULBRA_VINCULO_BLOQUEADO", "alunos", aluno_id, {
      chaves: ordem,
      motivo: d.motivo,
      ulbra_cliente_id_candidato: d.ulbra_cliente_id_candidato,
    });
    return responder({ status: "bloqueado", motivo: d.motivo });
  }

  if (d.acao !== "criar") {
    console.error("ulbra-consultar: decisao inesperada", (d as { acao: string }).acao);
    return responder({ erro: "DECISAO_INESPERADA" }, 500);
  }

  const { data: novo, error: erroVinculo } = await sbService
    .from("ulbra_vinculos")
    .insert({
      aluno_id,
      ulbra_cliente_id: d.ulbra_cliente_id,
      telefone_e164: d.telefone_e164,
      confianca: CONFIANCA.ALTA_CPF,
      origem: "cpf",
      vinculado_por: usuario,
    })
    .select("id")
    .single();

  if (erroVinculo || !novo) {
    // Inclui o caso em que o índice único de cliente ativo (proposta
    // 20261104200000) barrou a corrida de duas chamadas simultâneas: o banco
    // é o último portão, e perder essa corrida é o comportamento correto.
    console.error("ulbra-consultar: falha ao gravar vínculo", erroVinculo?.message);
    await auditar("ULBRA_CONSULTA", "alunos", aluno_id, {
      chaves: ordem,
      resultado: "VINCULO_NAO_GRAVADO",
      ulbra_cliente_id: d.ulbra_cliente_id,
    });
    return responder({ erro: "VINCULO_NAO_GRAVADO" }, 500);
  }

  await auditar("ULBRA_VINCULO_CRIADO", "ulbra_vinculos", novo.id, {
    origem: "cpf",
    confianca: CONFIANCA.ALTA_CPF,
    telefone_concordou: d.telefone_concordou,
    // Telefone apontou alguém fora do escopo do token: comparação impossível,
    // CPF mandou. Fica registrado para não passar como concordância.
    telefone_fora_do_escopo: d.telefone_fora_do_escopo,
    ulbra_cliente_id: d.ulbra_cliente_id,
    equipe: d.equipe,
    em_atendimento: d.em_atendimento,
  });

  return responder({
    status: "vinculado",
    ulbra_cliente_id: d.ulbra_cliente_id,
    confianca: CONFIANCA.ALTA_CPF,
    origem: "cpf",
    reconfirmar_recomendado: false,
    url: urlCliente(d.ulbra_cliente_id),
  });
});

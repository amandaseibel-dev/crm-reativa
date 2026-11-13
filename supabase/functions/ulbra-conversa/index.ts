// ===========================================================================
// CONEXÃO INDIVIDUAL e RESPOSTA pela Mensageria ULBRA — Edge Function.
// PREPARADA, NÃO PUBLICADA. Lógica pura em oauth.ts, conexao.ts, envio.ts,
// previa.ts e cripto.ts (todas testadas sem rede).
//
// Ações (corpo JSON `acao`), sempre com o JWT do usuário (verify_jwt = true):
//   conexao_iniciar     -> gera PKCE+state, guarda o pedido, devolve a URL de autorização
//   conexao_concluir    -> {code, state}: troca o código, cifra e guarda os tokens e lê
//                          meu_acesso com o token DO OPERADOR (1 chamada da cota dele)
//   conexao_estado      -> SEM_CONEXAO | ATIVA | EXPIRANDO | EXPIRADA | REVOGADA (+ pessoa, escopos)
//   conexao_desconectar -> revoga no provedor e marca revogada localmente
//   envio_previa        -> {conversa_id | atendimento_id, texto}: valida AGORA e registra a
//                          prévia no servidor (validade curta). NÃO chama a Mensageria.
//   envio_confirmar     -> {previa_id, texto, chave}: consome a prévia uma vez, revalida e envia
//                          (só com ULBRA_ENVIO_REAL=true). Templates: recusados.
//
// NUNCA usa ULBRA_MCP_TOKEN para enviar: o token é sempre o do operador.
// ===========================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ESCOPOS_MINIMOS, gerarPkce, renovarToken, revogarToken, trocarCodigo, urlDeAutorizacao, validarRetorno, type Fetch } from "./oauth.ts";
import { chaveDeHex, cifrar, decifrar } from "./cripto.ts";
import { estadoConexao, garantirConexao, type ProvedorOAuth, type RegistroConexao } from "./conexao.ts";
import { RecusadoPelaUlbra, enviarResposta, type Envio, type PedidoEnvio, type RepositorioEnvio, type ResultadoEnvio } from "./envio.ts";
import { confirmarPrevia, criarPrevia, type PreviaRegistro, type RepositorioPrevia } from "./previa.ts";

const MCP_URL = "https://crm.ulbra.ai/api/mcp";
const ACCEPT_MCP = "application/json, text/event-stream";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function responder(corpo: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function lerCorpoMcp(contentType: string | null, corpo: string): unknown {
  if (!(contentType ?? "").toLowerCase().includes("text/event-stream")) return JSON.parse(corpo);
  for (const evento of corpo.split(/\r?\n\r?\n/)) {
    const dados = evento.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (dados.trim()) return JSON.parse(dados);
  }
  throw new Error("SSE_SEM_DADOS");
}
function extrairResultado(envelope: unknown): { dados: unknown; erro: string | null } {
  const env = envelope as { error?: { message?: string }; result?: { content?: Array<{ text?: string }>; isError?: boolean } };
  if (env?.error) return { dados: null, erro: env.error.message ?? "MCP_ERRO" };
  const texto = env?.result?.content?.[0]?.text;
  if (typeof texto !== "string") return { dados: null, erro: "ENVELOPE_SEM_CONTEUDO" };
  let dados: unknown;
  try { dados = JSON.parse(texto); } catch { dados = texto; }
  return { dados, erro: env?.result?.isError ? (typeof dados === "string" ? dados : JSON.stringify(dados)) : null };
}
/** Chamada ao MCP com o token DO OPERADOR. */
async function chamarComoOperador(accessToken: string, nome: string, args: Record<string, unknown>) {
  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: ACCEPT_MCP, Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: nome, arguments: args } }),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error("ULBRA_AUTENTICACAO");
  if (resp.status === 429) throw new Error("ULBRA_LIMITE");
  if (!resp.ok) throw new Error(`ULBRA_HTTP_${resp.status}`);
  return extrairResultado(lerCorpoMcp(resp.headers.get("content-type"), await resp.text()));
}

const fetchForm: Fetch = (url, init) => fetch(url, init);
const ATENDIMENTO_RE = /^[a-f0-9]{24}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return responder({ erro: "SEM_TOKEN" }, 401);
  const urlBanco = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const servico = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const clientId = Deno.env.get("ULBRA_OAUTH_CLIENT_ID");
  const redirectUri = Deno.env.get("ULBRA_OAUTH_REDIRECT_URI");
  const chaveHex = Deno.env.get("ULBRA_TOKENS_CHAVE");
  // Duas chaves: a ULBRA_ENVIO_REAL sozinha não basta. O contrato real da prévia exigida pela
  // ULBRA precisa estar confirmado (ULBRA_CONTRATO_PREVIA_CONFIRMADO=true) antes de qualquer envio real.
  const envioReal = Deno.env.get("ULBRA_ENVIO_REAL") === "true" && Deno.env.get("ULBRA_CONTRATO_PREVIA_CONFIRMADO") === "true";
  if (!urlBanco || !anon || !servico) return responder({ erro: "CONFIG_AUSENTE" }, 500);

  const corpo = await req.json().catch(() => ({})) as Record<string, unknown>;
  const acao = String(corpo.acao ?? "");

  const sbUser = createClient(urlBanco, anon, { global: { headers: { Authorization: auth } } });
  const sb = createClient(urlBanco, servico, { auth: { persistSession: false } });
  const { data: { user } } = await sbUser.auth.getUser();
  if (!user?.email) return responder({ erro: "ACESSO_NEGADO" }, 403);
  const email = user.email.toLowerCase();
  const { data: usuario } = await sb.from("usuarios").select("email, perfil, ativo").ilike("email", email).eq("ativo", true).limit(1).maybeSingle();
  if (!usuario) return responder({ erro: "ACESSO_NEGADO" }, 403);

  // Templates ficam fora desta entrega: recusa explícita, nunca envio silencioso como texto.
  if (corpo.template !== undefined && corpo.template !== null) {
    return responder({ ok: false, situacao: "BLOQUEADO", motivos: ["TEMPLATE_NAO_NESTA_ENTREGA"] }, 400);
  }

  // Dependências que exigem configuração: só quando a ação precisa delas.
  const precisaOauth = ["conexao_iniciar", "conexao_concluir", "conexao_desconectar", "envio_previa", "envio_confirmar", "conexao_estado"].includes(acao);
  if (precisaOauth && (!clientId || !redirectUri || !chaveHex)) {
    return responder({ ok: false, motivo: "CONEXAO_NAO_CONFIGURADA", detalhe: "client_id/redirect_uri/chave de cifra ausentes no ambiente da função" }, 503);
  }
  const chave = chaveHex ? chaveDeHex(chaveHex) : null;

  async function lerRegistro(): Promise<RegistroConexao | null> {
    const { data: c } = await sb.from("ulbra_conexoes_operador").select("*").eq("operador_email", email).maybeSingle();
    if (!c || !c.access_token_cifrado) return null;
    return {
      operador_email: email,
      access_token: await decifrar(c.access_token_cifrado, chave!),
      refresh_token: c.refresh_token_cifrado ? await decifrar(c.refresh_token_cifrado, chave!) : null,
      expira_em_ms: c.expira_em ? Date.parse(c.expira_em) : 0,
      revogada_em_ms: c.revogada_em ? Date.parse(c.revogada_em) : null,
      pessoa_id: c.pessoa_id ?? null,
      pessoa_nome: c.pessoa_nome ?? null,
    };
  }
  async function guardarTokens(t: { access_token: string; refresh_token: string | null; expira_em_ms: number }, extra: Record<string, unknown> = {}) {
    await sb.from("ulbra_conexoes_operador").upsert({
      operador_email: email,
      access_token_cifrado: await cifrar(t.access_token, chave!),
      refresh_token_cifrado: t.refresh_token ? await cifrar(t.refresh_token, chave!) : null,
      expira_em: new Date(t.expira_em_ms).toISOString(),
      revogada_em: null,
      revogada_no_provedor: null,
      atualizado_em: new Date().toISOString(),
      ...extra,
    });
  }
  const provedorOAuth: ProvedorOAuth = {
    async renovar(refreshToken) {
      const t = await renovarToken({ clientId: clientId!, refreshToken }, fetchForm, Date.now());
      await guardarTokens(t);
      return t;
    },
    async revogar(tk) { await revogarToken({ clientId: clientId!, token: tk }, fetchForm); },
  };

  // Repositório de envios. Falha de gravação lança; só a chave repetida (23505) devolve false.
  const repositorio: RepositorioEnvio = {
    async buscar(operador, ch) {
      const { data } = await sb.from("ulbra_envios").select("*").eq("operador_email", operador).eq("chave", ch).maybeSingle();
      if (!data) return null;
      return { chave: data.chave, operador_email: data.operador_email, atendimento_id: data.atendimento_id, texto: data.texto, status: data.status, ulbra_mensagem_id: data.ulbra_mensagem_id, motivo: data.motivo, criado_em_ms: Date.parse(data.criado_em), previa_id: data.previa_id ?? null };
    },
    async inserirSeNovo(e: Envio) {
      const { error } = await sb.from("ulbra_envios").insert({ chave: e.chave, operador_email: e.operador_email, atendimento_id: e.atendimento_id, texto: e.texto, status: e.status, previa_id: e.previa_id });
      if (!error) return "NOVO" as const;
      if ((error as { code?: string }).code === "23505") {
        const msg = String((error as { message?: string }).message ?? "");
        if (msg.includes("ulbra_envios_chave_unica")) return "CHAVE_EXISTENTE" as const;
        if (msg.includes("ulbra_envios_texto_em_aberto_unica")) return "TEXTO_EM_ABERTO" as const;
      }
      throw new Error("ENVIO_NAO_GRAVADO");
    },
    async existeFalhaIncerta(atendimentoId, texto) {
      const { data } = await sb.from("ulbra_envios").select("chave").eq("atendimento_id", atendimentoId).eq("texto", texto).eq("status", "FALHA_INCERTA").limit(1);
      return (data?.length ?? 0) > 0;
    },
    async atualizar(operador, ch, campos) {
      const { error } = await sb.from("ulbra_envios").update({ ...campos, atualizado_em: new Date().toISOString() }).eq("operador_email", operador).eq("chave", ch);
      // Falha de atualização não pode ser silenciosa: o envio ficaria sem registro do resultado.
      if (error) throw new Error("ENVIO_NAO_ATUALIZADO");
    },
  };

  const repositorioPrevia: RepositorioPrevia = {
    async inserir(p: PreviaRegistro) {
      const { error } = await sb.from("ulbra_envio_previas").insert({
        id: p.id, operador_email: p.operador_email, atendimento_id: p.atendimento_id, ulbra_cliente_id: p.ulbra_cliente_id,
        conteudo_hash: p.conteudo_hash, criado_em: new Date(p.criado_em_ms).toISOString(), expira_em: new Date(p.expira_em_ms).toISOString(), consumida_em: null,
      });
      if (error) throw new Error("PREVIA_NAO_GRAVADA");
    },
    async buscar(id) {
      if (!UUID_RE.test(id)) return null;
      const { data } = await sb.from("ulbra_envio_previas").select("*").eq("id", id).maybeSingle();
      if (!data) return null;
      return { id: data.id, operador_email: data.operador_email, atendimento_id: data.atendimento_id, ulbra_cliente_id: data.ulbra_cliente_id, conteudo_hash: data.conteudo_hash, expira_em_ms: Date.parse(data.expira_em), consumida_em_ms: data.consumida_em ? Date.parse(data.consumida_em) : null };
    },
    async consumir(id, operador, agoraMs) {
      // Consumo atômico: só altera a linha se ainda não consumida, do mesmo operador e dentro da validade.
      const agora = new Date(agoraMs).toISOString();
      const { data, error } = await sb.from("ulbra_envio_previas").update({ consumida_em: agora }).eq("id", id).eq("operador_email", operador).is("consumida_em", null).gt("expira_em", agora).select("id");
      if (error) throw new Error("PREVIA_NAO_CONSUMIDA");
      return (data?.length ?? 0) === 1;
    },
  };

  /** Monta o pedido com o estado AGORA: atendimento, responsável, carteira, janela e conta conectada. */
  async function montarPedido(atendimentoId: string, texto: string, chaveEnvio: string, conta: RegistroConexao): Promise<{ pedido: PedidoEnvio } | { bloqueio: ResultadoEnvio; status: number }> {
    const { data: at } = await sb.from("ulbra_atendimentos").select("ulbra_cliente_id, responsavel_email, dispensado_em").eq("ulbra_atendimento_id", atendimentoId).maybeSingle();
    if (!at) return { bloqueio: { situacao: "BLOQUEADO", motivos: ["ATENDIMENTO_NAO_ESPELHADO"] }, status: 404 };
    const { data: v } = await sb.from("ulbra_vinculos").select("aluno_id").eq("ulbra_cliente_id", at.ulbra_cliente_id).is("desvinculado_em", null).eq("confianca", "alta_cpf").maybeSingle();
    const alunoId = (v?.aluno_id as string | null) ?? null;
    let dono: string | null = null;
    if (alunoId) {
      const { data: casos } = await sb.from("casos").select("operador_email").eq("aluno_id", alunoId).not("operador_email", "is", null);
      const donos = [...new Set((casos ?? []).map((k) => String(k.operador_email).toLowerCase()))];
      dono = donos.length === 1 ? donos[0] : null;
    }
    const { data: conv } = await sb.from("ulbra_conversas").select("ultima_mensagem_cliente_em").eq("ulbra_cliente_id", at.ulbra_cliente_id).order("ultima_mensagem_em", { ascending: false }).limit(1).maybeSingle();
    return {
      pedido: {
        operador: email, atendimento_id: atendimentoId, ulbra_cliente_id: at.ulbra_cliente_id ? String(at.ulbra_cliente_id) : null,
        texto, chave: chaveEnvio,
        ultima_mensagem_cliente_em_ms: conv?.ultima_mensagem_cliente_em ? Date.parse(conv.ultima_mensagem_cliente_em) : null,
        agora_ms: Date.now(), dono_carteira: dono,
        responsavel_atendimento: at.responsavel_email ? String(at.responsavel_email).toLowerCase() : null,
        identidade_confirmada: Boolean(alunoId),
        // FONTE DO ATENDENTE NÃO DEFINIDA: nenhuma coluna ou contrato a fornece hoje. Null bloqueia o envio.
        atendente_ulbra: null,
        conta_conectada: { pessoa_id: conta.pessoa_id ?? null, pessoa_nome: conta.pessoa_nome ?? null },
      },
    };
  }

  try {
    if (acao === "conexao_estado") {
      const r = await lerRegistro();
      const { data: c } = await sb.from("ulbra_conexoes_operador").select("pessoa_nome, escopos, so_leitura, conectada_em").eq("operador_email", email).maybeSingle();
      return responder({ ok: true, estado: estadoConexao(r, Date.now()), pessoa: c?.pessoa_nome ?? null, escopos: c?.escopos ?? null, so_leitura: c?.so_leitura ?? null, conectada_em: c?.conectada_em ?? null, envio_real: envioReal });
    }

    if (acao === "conexao_iniciar") {
      const p = await gerarPkce();
      await sb.from("ulbra_conexoes_pedidos").delete().eq("operador_email", email);
      const { error } = await sb.from("ulbra_conexoes_pedidos").insert({ state: p.state, operador_email: email, verifier: p.verifier });
      if (error) return responder({ ok: false, motivo: "PEDIDO_NAO_GRAVADO" }, 500);
      return responder({ ok: true, url: urlDeAutorizacao({ clientId: clientId!, redirectUri: redirectUri!, challenge: p.challenge, state: p.state }), escopos: ESCOPOS_MINIMOS });
    }

    if (acao === "conexao_concluir") {
      const state = typeof corpo.state === "string" ? corpo.state : "";
      const { data: pedido } = await sb.from("ulbra_conexoes_pedidos").select("state, verifier, criado_em").eq("operador_email", email).eq("state", state).maybeSingle();
      const v = validarRetorno(corpo, pedido ? { state: pedido.state, criado_em_ms: Date.parse(pedido.criado_em) } : null, Date.now());
      if (!v.ok) return responder({ ok: false, motivo: v.motivo }, 400);
      const t = await trocarCodigo({ clientId: clientId!, redirectUri: redirectUri!, code: v.code, verifier: pedido!.verifier }, fetchForm, Date.now());
      await sb.from("ulbra_conexoes_pedidos").delete().eq("state", state);
      // Quem é a pessoa do token: 1 chamada da cota DO OPERADOR. Prova a autoria antes de qualquer envio.
      let pessoa: Record<string, unknown> = {};
      try {
        const { dados } = await chamarComoOperador(t.access_token, "meu_acesso", {});
        const a = dados as { pessoa?: { nome?: string; id?: string }; nome?: string; escopos?: unknown; soLeitura?: unknown };
        pessoa = { pessoa_nome: a?.pessoa?.nome ?? a?.nome ?? null, pessoa_id: a?.pessoa?.id ?? null, escopos: a?.escopos ?? null, so_leitura: typeof a?.soLeitura === "boolean" ? a.soLeitura : null };
      } catch (e) {
        pessoa = { pessoa_nome: null, escopos: null, so_leitura: null };
        console.error("ulbra-conversa: meu_acesso do operador falhou", (e as Error).message);
      }
      await guardarTokens(t, { conectada_em: new Date().toISOString(), ...pessoa });
      return responder({ ok: true, estado: "ATIVA", pessoa: pessoa.pessoa_nome ?? null, escopos: pessoa.escopos ?? null, escopo_token: t.escopo });
    }

    if (acao === "conexao_desconectar") {
      const r = await lerRegistro();
      if (!r) return responder({ ok: true, estado: "SEM_CONEXAO" });
      let noProvedor = false;
      try { await provedorOAuth.revogar(r.refresh_token ?? r.access_token); noProvedor = true; } catch { noProvedor = false; }
      await sb.from("ulbra_conexoes_operador").update({ revogada_em: new Date().toISOString(), revogada_no_provedor: noProvedor, access_token_cifrado: null, refresh_token_cifrado: null, atualizado_em: new Date().toISOString() }).eq("operador_email", email);
      return responder({ ok: true, estado: "REVOGADA", revogada_no_provedor: noProvedor });
    }

    if (acao === "envio_previa") {
      // Não chama a Mensageria: valida agora e registra a prévia no servidor.
      const texto = String(corpo.texto ?? "");
      let atendimentoId = String(corpo.atendimento_id ?? "");
      if (!atendimentoId && typeof corpo.conversa_id === "string" && /^[a-f0-9]{24}$/.test(corpo.conversa_id)) {
        const { data: cv } = await sb.from("ulbra_conversas").select("ulbra_cliente_id").eq("ulbra_conversa_id", corpo.conversa_id).maybeSingle();
        if (!cv) return responder({ ok: false, situacao: "BLOQUEADO", motivos: ["CONVERSA_NAO_ESPELHADA"] }, 404);
        const { data: ativo } = await sb.from("ulbra_atendimentos").select("ulbra_atendimento_id").eq("ulbra_cliente_id", cv.ulbra_cliente_id).is("dispensado_em", null).order("entrou_em", { ascending: false }).limit(1).maybeSingle();
        if (!ativo) return responder({ ok: false, situacao: "BLOQUEADO", motivos: ["SEM_ATENDIMENTO_ATIVO"] }, 404);
        atendimentoId = String(ativo.ulbra_atendimento_id);
      }
      if (!ATENDIMENTO_RE.test(atendimentoId)) return responder({ ok: false, motivo: "ATENDIMENTO_INVALIDO" }, 400);
      // Desativação: com ULBRA_ENVIO_REAL desligado, nem prévia nem envio. Nada é apagado.
      if (!envioReal) return responder({ ok: false, situacao: "BLOQUEADO", motivos: ["ENVIO_DESATIVADO"] }, 403);
      const conn = await garantirConexao(await lerRegistro(), provedorOAuth, Date.now());
      if (!conn.ok) return responder({ ok: false, situacao: "BLOQUEADO", motivos: [conn.motivo] }, 403);
      const m = await montarPedido(atendimentoId, texto, "previa-sem-envio", conn.registro);
      if ("bloqueio" in m) return responder({ ok: false, ...m.bloqueio }, m.status);
      const r = await criarPrevia(m.pedido, { repositorioPrevia, gerarId: () => crypto.randomUUID(), agora: () => Date.now() });
      await sb.from("auditoria").insert({ usuario: email, acao: "ULBRA_PREVIA", tabela_afetada: "ulbra_envio_previas", registro_id: atendimentoId, detalhes: { situacao: r.situacao, motivos: "motivos" in r ? r.motivos : null } }).then(() => {}, () => {});
      return responder({ ok: r.situacao === "CRIADA", ...r }, r.situacao === "CRIADA" ? 200 : 403);
    }

    if (acao === "envio_confirmar") {
      const previaId = String(corpo.previa_id ?? "");
      const texto = String(corpo.texto ?? "");
      const chaveEnvio = String(corpo.chave ?? "");
      const previa = UUID_RE.test(previaId) ? await repositorioPrevia.buscar(previaId) : null;
      // O atendimento vem da PRÉVIA, nunca do corpo da requisição.
      if (!previa) return responder({ ok: false, situacao: "BLOQUEADO", motivos: ["PREVIA_NAO_ENCONTRADA"] }, 403);
      const conn = await garantirConexao(await lerRegistro(), provedorOAuth, Date.now());
      if (!conn.ok) return responder({ ok: false, situacao: "BLOQUEADO", motivos: [conn.motivo] }, 403);
      const m = await montarPedido(previa.atendimento_id, texto, chaveEnvio, conn.registro);
      if ("bloqueio" in m) return responder({ ok: false, ...m.bloqueio }, m.status);
      const r = await confirmarPrevia(m.pedido, previaId, {
        repositorio, repositorioPrevia, provedorOAuth, conexao: conn.registro, envioRealConfirmado: envioReal, agora: () => Date.now(),
        gerarId: () => crypto.randomUUID(),
        provedorEnvio: {
          async enviar(p) {
            const { dados, erro } = await chamarComoOperador(p.access_token, "enviar_mensagem_whatsapp", { atendimento: p.atendimento_id, texto: p.texto, chave: p.chave });
            if (erro) throw new RecusadoPelaUlbra(erro);
            const d = dados as { mensagem?: { id?: string }; id?: string; situacao?: string };
            return { ulbra_mensagem_id: d?.mensagem?.id ?? d?.id ?? d?.situacao ?? "sem_id" };
          },
        },
      });
      await sb.from("auditoria").insert({ usuario: email, acao: "ULBRA_ENVIO", tabela_afetada: "ulbra_envios", registro_id: previa.atendimento_id, detalhes: { situacao: r.situacao, status: "envio" in r ? r.envio.status : null, motivos: "motivos" in r ? r.motivos : null } }).then(() => {}, () => {});
      return responder({ ok: r.situacao !== "BLOQUEADO", ...r }, r.situacao === "BLOQUEADO" ? 403 : 200);
    }

    return responder({ erro: "ACAO_INVALIDA" }, 400);
  } catch (e) {
    const m = (e as Error).message;
    console.error("ulbra-conversa: falhou", m);
    return responder({ ok: false, motivo: m.startsWith("ULBRA_") || m.startsWith("TOKEN_") || m.startsWith("RENOVACAO_") ? m : "FALHA_INTERNA" }, 502);
  }
});

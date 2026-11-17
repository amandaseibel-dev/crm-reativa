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
import { type Envio, type PedidoEnvio, type RepositorioEnvio, type ResultadoEnvio } from "./envio.ts";
import { confirmarPrevia, criarPrevia, type PreviaRegistro, type RepositorioPrevia } from "./previa.ts";
import { podeConferir } from "./conferencia.ts";
import { capacidadeHistorico, lerHistoricoAutorizado, type DepsHistorico } from "./historico-leitura.ts";
import { cadastrarTokenPessoal } from "./token-pessoal.ts";

// A3: leitura GLOBAL só pela regra temLeituraGlobal (leitura.ts): amanda.seibel e cobranca04. O restante lê só a própria carteira/responsabilidade.


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
  // ilike do PostgREST trata * como curinga (recusado). \ % _ são escapados: e-mail legítimo com _ continua valendo.
  if (email.includes("*")) return responder({ erro: "ACESSO_NEGADO" }, 403);
  const emailLike = email.replace(/[\\%_]/g, (c) => "\\" + c);
  const { data: usuario } = await sb.from("usuarios").select("email, perfil, ativo").ilike("email", emailLike).eq("ativo", true).limit(1).maybeSingle();
  if (!usuario) return responder({ erro: "ACESSO_NEGADO" }, 403);

  // Templates ficam fora desta entrega: recusa explícita, nunca envio silencioso como texto.
  if (corpo.template !== undefined && corpo.template !== null) {
    return responder({ ok: false, situacao: "BLOQUEADO", motivos: ["TEMPLATE_NAO_NESTA_ENTREGA"] }, 400);
  }

  // Dependências que exigem configuração: só quando a ação precisa delas.
  // OAuth (client_id e redirect_uri) só nas ações do fluxo OAuth. As demais precisam só da chave de cifra:
  // o token pessoal (piloto) não passa pelo OAuth, e envio/histórico usam a conexão já gravada.
  const precisaOauth = ["conexao_iniciar", "conexao_concluir"].includes(acao);
  const precisaChave = ["conexao_token_pessoal", "conexao_desconectar", "conexao_estado", "envio_previa", "envio_confirmar", "historico_ler", "historico_capacidade"].includes(acao);
  if ((precisaOauth && (!clientId || !redirectUri || !chaveHex)) || (precisaChave && !chaveHex)) {
    return responder({ ok: false, motivo: "CONEXAO_NAO_CONFIGURADA", detalhe: "configuração ausente no ambiente da função (client_id/redirect_uri para OAuth; chave de cifra para as demais)" }, 503);
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
      pessoa_email: c.pessoa_email ?? null,
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
      return { chave: data.chave, operador_email: data.operador_email, atendimento_id: data.atendimento_id, texto: data.texto, status: data.status, ulbra_mensagem_id: data.ulbra_mensagem_id, motivo: data.motivo, criado_em_ms: Date.parse(data.criado_em), previa_id: data.previa_id ?? null, repeticao: typeof data.repeticao === "number" ? data.repeticao : 0 };
    },
    async inserirSeNovo(e: Envio) {
      const { error } = await sb.from("ulbra_envios").insert({ chave: e.chave, operador_email: e.operador_email, atendimento_id: e.atendimento_id, texto: e.texto, status: e.status, previa_id: e.previa_id, repeticao: e.repeticao });
      if (!error) return "NOVO" as const;
      if ((error as { code?: string }).code === "23505") {
        const msg = String((error as { message?: string }).message ?? "");
        if (msg.includes("ulbra_envios_chave_unica")) return "CHAVE_EXISTENTE" as const;
        if (msg.includes("ulbra_envios_texto_em_aberto_unica")) return "TEXTO_EM_ABERTO" as const;
      }
      throw new Error("ENVIO_NAO_GRAVADO");
    },
    async existeBloqueante(atendimentoId, texto, incluiConfirmados) {
      const estados = ["PENDENTE", "ENVIANDO", "FALHA_INCERTA", ...(incluiConfirmados ? ["ENVIADO", "CONFIRMADO_ENVIADO"] : [])];
      const { data } = await sb.from("ulbra_envios").select("chave").eq("atendimento_id", atendimentoId).eq("texto", texto).in("status", estados).limit(1);
      return (data?.length ?? 0) > 0;
    },
    async proximaRepeticao(atendimentoId, texto) {
      const { data } = await sb.from("ulbra_envios").select("repeticao").eq("atendimento_id", atendimentoId).eq("texto", texto).order("repeticao", { ascending: false }).limit(1);
      const maior = data?.[0]?.repeticao;
      return typeof maior === "number" ? maior + 1 : 0;
    },
    async atualizar(operador, ch, campos, de) {
      // Condição de estado no próprio UPDATE: a transição só acontece se o status ainda for o esperado.
      let q = sb.from("ulbra_envios").update({ ...campos, atualizado_em: new Date().toISOString() }).eq("operador_email", operador).eq("chave", ch);
      if (de) q = q.in("status", [...de]);
      const { data, error } = await q.select("chave");
      // Falha de atualização não pode ser silenciosa: o envio ficaria sem registro do resultado.
      if (error) throw new Error("ENVIO_NAO_ATUALIZADO");
      return (data?.length ?? 0) === 1;
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
      return { id: data.id, operador_email: data.operador_email, atendimento_id: data.atendimento_id, ulbra_cliente_id: data.ulbra_cliente_id, conteudo_hash: data.conteudo_hash, criado_em_ms: Date.parse(data.criado_em), expira_em_ms: Date.parse(data.expira_em), consumida_em_ms: data.consumida_em ? Date.parse(data.consumida_em) : null };
    },
    async consumir(id, operador, agoraMs) {
      // Consumo atômico: só altera a linha se ainda não consumida, do mesmo operador e dentro da validade.
      const agora = new Date(agoraMs).toISOString();
      const { data, error } = await sb.from("ulbra_envio_previas").update({ consumida_em: agora }).eq("id", id).eq("operador_email", operador).is("consumida_em", null).gt("expira_em", agora).select("id");
      if (error) throw new Error("PREVIA_NAO_CONSUMIDA");
      return (data?.length ?? 0) === 1;
    },
  };

  /** Auditoria: registro_id é uuid, então o id do atendimento vai em detalhes. Erro não é engolido. */
  async function auditar(acao: string, tabela: string, detalhes: Record<string, unknown>): Promise<boolean> {
    const { error } = await sb.from("auditoria").insert({ usuario: email, acao, tabela_afetada: tabela, registro_id: null, detalhes });
    if (error) console.error("ulbra-conversa: AUDITORIA NÃO GRAVADA", acao, error.message);
    return !error;
  }

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
        // FONTE DO ATENDENTE NÃO DEFINIDA. Candidato: ulbra_conversas.responsavel_ulbra. A equivalência com o
        // atendente exigido pela Mensageria NÃO está comprovada. Null bloqueia o envio.
        atendente_ulbra: null,
        conta_conectada: { pessoa_email: conta.pessoa_email ?? null, pessoa_nome: conta.pessoa_nome ?? null },
      },
    };
  }

  try {
    if (acao === "conexao_estado") {
      const r = await lerRegistro();
      const { data: c } = await sb.from("ulbra_conexoes_operador").select("pessoa_nome, escopos, so_leitura, conectada_em").eq("operador_email", email).maybeSingle();
      return responder({ ok: true, estado: estadoConexao(r, Date.now()), pessoa: c?.pessoa_nome ?? null, escopos: c?.escopos ?? null, so_leitura: c?.so_leitura ?? null, conectada_em: c?.conectada_em ?? null, envio_real: envioReal });
    }

    // Token pessoal (piloto): a pessoa dona do token precisa ser o usuário logado. Auditoria ANTES de gravar.
    if (acao === "conexao_token_pessoal") {
      const token = typeof corpo.token === "string" ? corpo.token : "";
      const validade = Number(corpo.validade_dias);
      try {
        // Não sobrescreve uma conexão OAuth ativa (grant com refresh): o upsert zeraria o refresh local,
        // e o grant seguiria válido no provedor sem cópia nem revogação. Desconecte o OAuth antes.
        // Fail-closed: se não consegue ler a conexão atual, não grava (sem isso, uma falha de leitura
        // deixaria passar a sobrescrita). Consulta direta, para tratar o erro do banco.
        const { data: atual, error: erroLeitura } = await sb.from("ulbra_conexoes_operador")
          .select("refresh_token_cifrado, revogada_em").eq("operador_email", email).maybeSingle();
        if (erroLeitura) return responder({ ok: false, motivo: "CONEXAO_NAO_VERIFICADA" }, 503);
        if (atual && atual.refresh_token_cifrado && !atual.revogada_em) {
          return responder({ ok: false, motivo: "CONEXAO_OAUTH_ATIVA" }, 409);
        }
        const r = await cadastrarTokenPessoal({
          email,
          agoraMs: Date.now(),
          identidadeDoToken: async (t) => {
            // chamarComoOperador devolve { dados, erro }. Erro da ferramenta vira indisponibilidade, não divergência.
            const { dados, erro } = await chamarComoOperador(t, "meu_acesso", {});
            if (erro) throw new Error("ULBRA_MCP_ERRO");
            const a = dados as { pessoa?: { nome?: string; email?: string }; escopos?: unknown; soLeitura?: unknown };
            return {
              pessoa_email: a?.pessoa?.email ?? null,
              pessoa_nome: a?.pessoa?.nome ?? null,
              escopos: a?.escopos ?? null,
              so_leitura: typeof a?.soLeitura === "boolean" ? a.soLeitura : null,
            };
          },
          guardar: async (dados, extra) => {
            const audito = await auditar("ULBRA_CONEXAO_TOKEN_PESSOAL", "ulbra_conexoes_operador", {
              pessoa_email: extra.pessoa_email ?? null,
              validade_dias: validade,
              escopos: extra.escopos ?? null,
            });
            if (!audito) throw new Error("AUDITORIA_NAO_GRAVADA");
            await guardarTokens({ access_token: dados.access_token, refresh_token: null, expira_em_ms: dados.expira_em_ms }, extra);
          },
        }, token, validade);
        if (!r.ok) {
          const status = r.motivo === "MENSAGERIA_INDISPONIVEL" ? 502 : r.motivo === "IDENTIDADE_DIVERGENTE" ? 403 : 400;
          return responder({ ok: false, motivo: r.motivo }, status);
        }
        return responder({ ok: true, ...r });
      } catch (e) {
        if ((e as Error).message === "AUDITORIA_NAO_GRAVADA") return responder({ ok: false, motivo: "AUDITORIA_NAO_GRAVADA" }, 500);
        console.error("ulbra-conversa: cadastro de token pessoal falhou", (e as Error).message);
        return responder({ ok: false, motivo: "FALHA_CADASTRO_TOKEN" }, 500);
      }
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
      let indisponivel = false;
      try {
        const { dados, erro } = await chamarComoOperador(t.access_token, "meu_acesso", {});
        // Erro da ferramenta NÃO é divergência de identidade: não revoga o token, só informa indisponibilidade.
        if (erro) throw new Error("ULBRA_MCP_ERRO");
        const a = dados as { pessoa?: { nome?: string; email?: string }; nome?: string; escopos?: unknown; soLeitura?: unknown };
        // Campo de identidade disponível em meu_acesso: pessoa.email (pessoa.id não aparece no retorno).
        // Estabilidade e equivalência com o atendente NÃO comprovadas: a comparação segue fail-closed.
        pessoa = { pessoa_nome: a?.pessoa?.nome ?? null, pessoa_email: a?.pessoa?.email ?? null, escopos: a?.escopos ?? null, so_leitura: typeof a?.soLeitura === "boolean" ? a.soLeitura : null };
      } catch (e) {
        // pessoa_email explícito: o upsert não pode herdar o e-mail de uma conexão anterior (outra conta).
        pessoa = { pessoa_nome: null, pessoa_email: null, escopos: null, so_leitura: null };
        indisponivel = true;
        console.error("ulbra-conversa: meu_acesso do operador falhou", (e as Error).message);
      }
      if (indisponivel) return responder({ ok: false, motivo: "MENSAGERIA_INDISPONIVEL" }, 502);
      // A2: o operador A não pode conectar a conta B. Pessoa divergente ou ausente: revoga e não guarda nada.
      if (((pessoa.pessoa_email as string | null) ?? "").toLowerCase() !== email) {
        let revogadaNoProvedor = false;
        try { await provedorOAuth.revogar(t.access_token); revogadaNoProvedor = true; } catch { revogadaNoProvedor = false; }
        return responder({ ok: false, motivo: "IDENTIDADE_DIVERGENTE", revogada_no_provedor: revogadaNoProvedor }, 403);
      }
      await guardarTokens(t, { conectada_em: new Date().toISOString(), ...pessoa });
      return responder({ ok: true, estado: "ATIVA", pessoa: pessoa.pessoa_nome ?? null, escopos: pessoa.escopos ?? null, escopo_token: t.escopo });
    }

    if (acao === "conexao_desconectar") {
      const r = await lerRegistro();
      if (!r) return responder({ ok: true, estado: "SEM_CONEXAO" });
      // Token pessoal (sem refresh_token): não há revogação por API neste backend. Apaga a cópia local
      // e pede a revogação na Mensageria. NÃO se afirma revogação no provedor.
      const pessoal = r.refresh_token === null;
      let noProvedor = false;
      if (!pessoal) {
        try { await provedorOAuth.revogar(r.refresh_token ?? r.access_token); noProvedor = true; } catch { noProvedor = false; }
      }
      // A4: sem confirmação do provedor, a credencial CONTINUA guardada (cifrada) para tentar a revogação de novo.
      // Localmente ela já está revogada (revogada_em): nenhuma leitura ou envio a usa.
      const apagar = noProvedor || pessoal ? { access_token_cifrado: null, refresh_token_cifrado: null } : {};
      await sb.from("ulbra_conexoes_operador").update({ revogada_em: new Date().toISOString(), revogada_no_provedor: noProvedor, ...apagar, atualizado_em: new Date().toISOString() }).eq("operador_email", email);
      return responder({
        ok: true,
        estado: "REVOGADA",
        revogada_no_provedor: noProvedor,
        revogacao_manual_necessaria: pessoal ? "Revogue o token em MCP › Tokens pessoais na Mensageria. Desconectar aqui apaga só a cópia do CRM." : null,
      });
    }

    // Histórico sob demanda com a CONEXÃO INDIVIDUAL do operador (nunca a credencial central). Só leitura.
    // Histórico: a decisão vive em historico-leitura.ts (testada). Aqui só monta as dependências reais.
    if (acao === "historico_ler" || acao === "historico_capacidade") {
      const conversaId = typeof corpo.conversa_id === "string" ? corpo.conversa_id : "";
      const antesDe = typeof corpo.antes_de === "string" && corpo.antes_de ? corpo.antes_de : null;
      const deps: DepsHistorico = {
        email,
        usuarioAtivo: usuario?.ativo === true,
        flagLigada: Deno.env.get("ULBRA_HISTORICO_HABILITADO") === "true",
        conversaId,
        antesDe,
        buscarClienteDaConversa: async (id: string) => {
          const { data } = await sb.from("ulbra_conversas").select("ulbra_cliente_id").eq("ulbra_conversa_id", id).maybeSingle();
          return (data?.ulbra_cliente_id as string | undefined) ?? null;
        },
        alunoDoCliente: async (cid: string) => {
          const { data } = await sb.from("ulbra_vinculos").select("aluno_id").eq("ulbra_cliente_id", cid).is("desvinculado_em", null).eq("confianca", "alta_cpf").maybeSingle();
          return (data?.aluno_id as string | undefined) ?? null;
        },
        donosDoAluno: async (aid: string) => {
          const { data } = await sb.from("casos").select("operador_email").eq("aluno_id", aid).not("operador_email", "is", null);
          return (data ?? []).map((k) => String(k.operador_email));
        },
        responsaveisDoCliente: async (cid: string) => {
          const { data } = await sb.from("ulbra_atendimentos").select("responsavel_email").eq("ulbra_cliente_id", cid).is("dispensado_em", null).not("responsavel_email", "is", null);
          return (data ?? []).map((a) => String(a.responsavel_email));
        },
        conexao: async () => {
          const r = await lerRegistro();
          const conn = await garantirConexao(r, provedorOAuth, Date.now());
          if (!conn.ok) return { ok: false as const, motivo: conn.motivo };
          return { ok: true as const, access_token: conn.registro.access_token, pessoa_email: conn.registro.pessoa_email };
        },
        lerConversa: (token, args) => chamarComoOperador(token, "ler_conversa", args),
        auditar: (detalhes) => auditar("ULBRA_HISTORICO_LEITURA", "ulbra_conversas", detalhes),
      };
      if (acao === "historico_capacidade") {
        const c = await capacidadeHistorico(deps);
        return responder({ ok: true, ...c });
      }
      const s = await lerHistoricoAutorizado(deps);
      return responder(s.corpo, s.status);
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
      // A2: a conta conectada precisa ser a do próprio usuário autenticado. Divergência bloqueia, sem envio nem leitura.
      if ((conn.registro.pessoa_email ?? "").toLowerCase() !== email) return responder({ ok: false, situacao: "BLOQUEADO", motivos: ["IDENTIDADE_DIVERGENTE"] }, 403);
      const m = await montarPedido(atendimentoId, texto, "previa-sem-envio", conn.registro);
      if ("bloqueio" in m) return responder({ ok: false, ...m.bloqueio }, m.status);
      const r = await criarPrevia(m.pedido, { repositorioPrevia, gerarId: () => crypto.randomUUID(), agora: () => Date.now() });
      const auditoriaOk = await auditar("ULBRA_PREVIA", "ulbra_envio_previas", { atendimento_id: atendimentoId, situacao: r.situacao, motivos: "motivos" in r ? r.motivos : null });
      if (!auditoriaOk) return responder({ ok: false, motivo: "AUDITORIA_NAO_GRAVADA" }, 500);
      return responder({ ok: r.situacao === "CRIADA", ...r }, r.situacao === "CRIADA" ? 200 : 403);
    }

    if (acao === "envio_confirmar") {
      // Desativação ANTES de qualquer efeito: sem renovação de token, sem consumo de prévia.
      if (!envioReal) return responder({ ok: false, situacao: "BLOQUEADO", motivos: ["ENVIO_DESATIVADO"] }, 403);
      const previaId = String(corpo.previa_id ?? "");
      const texto = String(corpo.texto ?? "");
      const chaveEnvio = String(corpo.chave ?? "");
      const previa = UUID_RE.test(previaId) ? await repositorioPrevia.buscar(previaId) : null;
      // O atendimento vem da PRÉVIA, nunca do corpo da requisição.
      if (!previa) return responder({ ok: false, situacao: "BLOQUEADO", motivos: ["PREVIA_NAO_ENCONTRADA"] }, 403);
      const conn = await garantirConexao(await lerRegistro(), provedorOAuth, Date.now());
      if (!conn.ok) return responder({ ok: false, situacao: "BLOQUEADO", motivos: [conn.motivo] }, 403);
      // A2: a conta conectada precisa ser a do próprio usuário autenticado. Divergência bloqueia, sem envio nem leitura.
      if ((conn.registro.pessoa_email ?? "").toLowerCase() !== email) return responder({ ok: false, situacao: "BLOQUEADO", motivos: ["IDENTIDADE_DIVERGENTE"] }, 403);
      const m = await montarPedido(previa.atendimento_id, texto, chaveEnvio, conn.registro);
      if ("bloqueio" in m) return responder({ ok: false, ...m.bloqueio }, m.status);
      // Nova mensagem com o mesmo texto só com ação explícita do operador (e nova chave).
      m.pedido.repeticao_explicita = corpo.repeticao_explicita === true;
      const r = await confirmarPrevia(m.pedido, previaId, {
        repositorio, repositorioPrevia, provedorOAuth, conexao: conn.registro, envioRealConfirmado: envioReal, agora: () => Date.now(),
        gerarId: () => crypto.randomUUID(),
        provedorEnvio: {
          async enviar(p) {
            // Qualquer falha da chamada é AMBÍGUA: sem contrato comprovado, não se sabe se a mensagem saiu.
            // Por isso nunca vira recusa; vira FALHA_INCERTA, que bloqueia repetição.
            const resultado = await chamarComoOperador(p.access_token, "enviar_mensagem_whatsapp", { atendimento: p.atendimento_id, texto: p.texto, chave: p.chave, previa: false });
            if (resultado.erro) throw new Error("ENVIO_RESPOSTA_AMBIGUA");
            const d = resultado.dados as { mensagem?: { id?: string }; id?: string };
            const id = d?.mensagem?.id ?? d?.id;
            if (typeof id !== "string" || id === "") throw new Error("ENVIO_RESPOSTA_AMBIGUA");
            // A6: o contrato de sucesso do provedor NÃO está comprovado. Um id não é prova de envio:
            // o resultado fica em FALHA_INCERTA (conferência na Mensageria), nunca em ENVIADO.
            void id;
            throw new Error("ENVIO_CONTRATO_SUCESSO_NAO_COMPROVADO");
          },
        },
      });
      const auditoriaOk = await auditar("ULBRA_ENVIO", "ulbra_envios", { atendimento_id: previa.atendimento_id, situacao: r.situacao, status: "envio" in r ? r.envio.status : null, motivos: "motivos" in r ? r.motivos : null });
      // Envio já feito sem auditoria: avisa, sem sugerir reenvio. Quem decide é a conferência.
      return responder({ ok: r.situacao !== "BLOQUEADO", ...r, auditoria_gravada: auditoriaOk }, r.situacao === "BLOQUEADO" ? 403 : 200);
    }

    if (acao === "envio_conferencia") {
      // Só perfis de gestão. A decisão e a auditoria são gravadas pela função SQL ulbra_conferir_envio,
      // em UMA transação: se a auditoria falhar, a decisão é desfeita. Nunca reenvia.
      // Perfil de quem está logado, pela função canônica (usa o JWT do próprio conferidor, sem lookup por texto).
      const { data: perfilAtual } = await sbUser.rpc("perfil_do_usuario_atual");
      if (!podeConferir(perfilAtual)) {
        return responder({ ok: false, motivo: "ACESSO_NEGADO" }, 403);
      }
      const { data, error } = await sb.rpc("ulbra_conferir_envio", {
        p_operador: String(corpo.operador_email ?? "").toLowerCase(),
        p_chave: String(corpo.chave ?? ""),
        p_decisao: String(corpo.decisao ?? ""),
        p_motivo: String(corpo.motivo ?? ""),
        p_conferido_por: email,
        p_detalhes: {},
      });
      if (error) {
        console.error("ulbra-conversa: conferência NÃO gravada", error.message);
        return responder({ ok: false, motivo: "CONFERENCIA_NAO_GRAVADA" }, 500);
      }
      const res = data as { situacao: string; motivos?: string[]; status_anterior?: string };
      if (res.situacao === "BLOQUEADO") return responder({ ok: false, ...res }, 422);
      return responder({ ok: true, ...res, auditoria_gravada: true }, 200);
    }

    return responder({ erro: "ACAO_INVALIDA" }, 400);
  } catch (e) {
    const m = (e as Error).message;
    console.error("ulbra-conversa: falhou", m);
    return responder({ ok: false, motivo: m.startsWith("ULBRA_") || m.startsWith("TOKEN_") || m.startsWith("RENOVACAO_") ? m : "FALHA_INTERNA" }, 502);
  }
});

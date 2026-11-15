// ===========================================================================
// HISTÓRICO SOMENTE LEITURA de uma conversa da Mensageria — Edge Function.
// PREPARADA, NÃO PUBLICADA. Lógica em historico.ts (pura, testada).
//
// Portão: JWT do usuário (verify_jwt = true) + cadastro ativo; identidade por
// vínculo alta_cpf lida AGORA; permissão = dono da carteira ou responsável
// comprovado (operador) ou perfil amplo (gestão); orçamento reservado no banco
// ANTES da chamada (ulbra_historico_reservar); credencial de backend, só leitura.
// Nada é gravado com texto de mensagem. Nenhum envio.
// ===========================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  LIMITE_OPERADOR_DIA, RESERVA_GLOBAL, SALDO_VALIDADE_MS, TAMANHO_PAGINA,
  lerHistoricoSomenteLeitura, type DependenciasHistorico, type FotografiaSaldo,
} from "./historico.ts";
import type { ContextoLeitura } from "./leitura.ts";
import { buscarUsuarioAtivo, tokenDoHeader } from "./acesso.ts";

const MCP_URL = "https://crm.ulbra.ai/api/mcp";
const ACCEPT_MCP = "application/json, text/event-stream";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const PERFIS_AMPLOS = ["supervisor", "gerencia", "administrativo"];

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
function extrairResultado(envelope: unknown): unknown {
  const env = envelope as { error?: { message?: string }; result?: { content?: Array<{ text?: string }>; isError?: boolean } };
  if (env?.error) throw new Error(`MCP_ERRO: ${env.error.message ?? "sem mensagem"}`);
  if (env?.result?.isError) throw new Error("MCP_ERRO: isError");
  const texto = env?.result?.content?.[0]?.text;
  if (typeof texto !== "string") throw new Error("ENVELOPE_SEM_CONTEUDO");
  return JSON.parse(texto);
}

async function chamarMcp(token: string, nome: string, args: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: ACCEPT_MCP, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: nome, arguments: args } }),
  });
  if (!resp.ok) throw new Error(resp.status === 429 ? "ULBRA_LIMITE" : `ULBRA_HTTP_${resp.status}`);
  return extrairResultado(lerCorpoMcp(resp.headers.get("content-type"), await resp.text()));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("authorization");
  const tokenUsuario = tokenDoHeader(auth);
  if (!tokenUsuario) return responder({ erro: "SEM_TOKEN" }, 401);
  const token = Deno.env.get("ULBRA_MCP_TOKEN");
  const urlBanco = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const servico = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!token || !urlBanco || !anon || !servico) return responder({ erro: "CONFIG_AUSENTE" }, 500);

  const { conversa_id, antes_de } = await req.json().catch(() => ({}));
  if (typeof conversa_id !== "string" || !/^[a-f0-9]{24}$/.test(conversa_id)) return responder({ erro: "CONVERSA_INVALIDA" }, 400);
  const antesDe = typeof antes_de === "string" && antes_de ? antes_de : null;

  const sbUser = createClient(urlBanco, anon, { global: { headers: { Authorization: `Bearer ${tokenUsuario}` } } });
  const sb = createClient(urlBanco, servico, { auth: { persistSession: false } });
  const { data: { user } } = await sbUser.auth.getUser();
  if (!user?.email) return responder({ erro: "ACESSO_NEGADO" }, 403);
  const email = user.email.toLowerCase();
  const usuario = await buscarUsuarioAtivo(sb, email);
  if (!usuario) return responder({ erro: "ACESSO_NEGADO" }, 403);
  const gestao = PERFIS_AMPLOS.includes(String(usuario.perfil));

  const deps: DependenciasHistorico = {
    async consultarPermissao(operador, conversaId): Promise<ContextoLeitura | null> {
      const { data: c } = await sb.from("ulbra_conversas").select("ulbra_cliente_id, aluno_id").eq("ulbra_conversa_id", conversaId).maybeSingle();
      if (!c) return null;
      // identidade: vínculo ATIVO alta_cpf do cliente, lido agora
      const { data: v } = await sb.from("ulbra_vinculos").select("aluno_id").eq("ulbra_cliente_id", c.ulbra_cliente_id).is("desvinculado_em", null).eq("confianca", "alta_cpf").maybeSingle();
      const alunoId = (v?.aluno_id as string | null) ?? null;
      if (!alunoId) return { operador, identidade_confirmada: false, dono_carteira: null, responsavel_atendimento: null };
      // dono da carteira: só quando é UM operador com caso do aluno
      const { data: casos } = await sb.from("casos").select("operador_email").eq("aluno_id", alunoId).not("operador_email", "is", null);
      const donos = [...new Set((casos ?? []).map((k) => String(k.operador_email).toLowerCase()))];
      const dono = donos.length === 1 ? donos[0] : null;
      // responsável comprovado pelo atendimento (aceite no ReATIVA), quando é UMA pessoa
      const { data: ats } = await sb.from("ulbra_atendimentos").select("responsavel_email").eq("ulbra_cliente_id", c.ulbra_cliente_id).is("dispensado_em", null).not("responsavel_email", "is", null);
      const resps = [...new Set((ats ?? []).map((a) => String(a.responsavel_email).toLowerCase()))];
      const responsavel = resps.length === 1 ? resps[0] : null;
      // gestão: lê qualquer conversa com CPF confirmado (passa como se fosse a dona)
      return { operador, identidade_confirmada: true, dono_carteira: gestao ? operador : dono, responsavel_atendimento: responsavel };
    },
    async lerSaldo(): Promise<FotografiaSaldo | null> {
      const { data: e } = await sb.from("ulbra_sync_estado").select("saldo_api_restam, saldo_api_em").eq("id", true).maybeSingle();
      if (!e || e.saldo_api_restam == null || !e.saldo_api_em) return null;
      const fresco = Date.now() - Date.parse(e.saldo_api_em) <= SALDO_VALIDADE_MS;
      if (fresco) return { restam: Number(e.saldo_api_restam), em: String(e.saldo_api_em) };
      // Fotografia vencida: 1 chamada de meu_acesso (reservada antes) para não presumir saldo.
      const r = await deps.reservar(email, 1, LIMITE_OPERADOR_DIA, Number(e.saldo_api_restam) - RESERVA_GLOBAL);
      if (!r.permitido) return null;
      try {
        const acesso = await chamarMcp(token, "meu_acesso", {}) as { limites?: { pessoaPorDia?: { restam?: number } } };
        const restam = acesso?.limites?.pessoaPorDia?.restam;
        if (typeof restam !== "number") return null;
        const em = new Date().toISOString();
        await sb.from("ulbra_sync_estado").update({ saldo_api_restam: restam, saldo_api_em: em }).eq("id", true);
        return { restam, em };
      } catch {
        return null;
      }
    },
    async reservar(operador, quantidade, tetoOperador, tetoGlobal) {
      const { data, error } = await sb.rpc("ulbra_historico_reservar", {
        p_operador: operador, p_dia: new Date().toISOString().slice(0, 10), p_quantidade: quantidade,
        p_teto_operador: tetoOperador, p_teto_global: Math.max(0, tetoGlobal),
      });
      if (error) throw new Error(`RESERVA_FALHOU: ${error.message}`);
      const linha = Array.isArray(data) ? data[0] : data;
      return { permitido: Boolean(linha?.permitido), usadasOperador: Number(linha?.usadas_operador ?? 0), usadasGlobal: Number(linha?.usadas_global ?? 0) };
    },
    lerConversa: (conversaId, antes, limite) => chamarMcp(token, "ler_conversa", antes ? { id: conversaId, limite, antesDe: antes } : { id: conversaId, limite }),
    agora: () => Date.now(),
  };

  try {
    const r = await lerHistoricoSomenteLeitura(email, conversa_id, antesDe, deps);
    if (!r.ok) return responder({ ok: false, motivo: r.motivo }, r.motivo === "SEM_PERMISSAO_NA_CONVERSA" || r.motivo === "IDENTIDADE_NAO_CONFIRMADA" ? 403 : 200);
    return responder({ ok: true, origem: r.origem, chamadas: r.chamadas, pagina: r.pagina, tamanho: TAMANHO_PAGINA, alcance: r.alcance });
  } catch (e) {
    console.error("ulbra-historico: falhou", (e as Error).message);
    return responder({ ok: false, motivo: "ULBRA_INDISPONIVEL" }, 502);
  }
});

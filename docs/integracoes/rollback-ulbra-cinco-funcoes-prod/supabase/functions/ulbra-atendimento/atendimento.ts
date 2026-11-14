// Contrato de listar_atendimentos da Mensageria Ulbra (forma medida em
// 2026-11-04) e o recorte que a ficha mostra. Isolado do Deno para teste.

export const MCP_URL = "https://crm.ulbra.ai/api/mcp";
export const TTL_MS = 5 * 60 * 1000;

export interface AtendimentoMcp {
  id: string;
  cliente?: { id?: string; nome?: string | null } | null;
  situacao?: string | null;
  coluna?: string | null;
  equipe?: string | null;
  atendente?: string | null;
  entrouEm?: string | null;
  aceitoEm?: string | null;
  atualizadoEm?: string | null;
}

export interface AtendimentoFicha {
  id: string;
  situacao: string | null;
  coluna: string | null;
  equipe: string | null;
  atendente: string | null;
  entrou_em: string | null;
  atualizado_em: string | null;
}

export function montarChamada(clienteId: string, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "listar_atendimentos", arguments: { cliente: clienteId, limite: 1 } },
  };
}

// ---------------------------------------------------------------------------
// A Mensageria responde o MCP por SSE. Medido em 2026-11-07 contra
// crm.ulbra.ai/api/mcp, com credencial de backend:
//
//   sem `Accept`                               -> HTTP 406
//   com `Accept: application/json, text/event-stream` -> HTTP 200,
//                                     `content-type: text/event-stream`
//
// e o corpo vem no enquadramento padrao do SSE, com o envelope JSON-RPC
// inteiro numa linha `data:`:
//
//   event: message
//   data: {"result":{...},"jsonrpc":"2.0","id":1}
//
// `resp.json()` quebra nesse corpo. Por isso a leitura passa por aqui: devolve
// o ENVELOPE a partir do corpo bruto, aceitando as duas formas (JSON direto e
// SSE). Falha FECHADO: corpo sem `data:` levanta, e quem chama ja trata
// excecao como ULBRA_INDISPONIVEL, sem gravar vinculo.
// ---------------------------------------------------------------------------

/** Cabecalho exigido pelo MCP sobre HTTP. Sem ele a resposta e 406. */
export const ACCEPT_MCP = "application/json, text/event-stream";

export function lerCorpoMcp(contentType: string | null, corpo: string): unknown {
  if (!(contentType ?? "").toLowerCase().includes("text/event-stream")) {
    return JSON.parse(corpo);
  }
  // Eventos separados por linha em branco. Dentro de um evento, cada linha
  // `data:` e um pedaco do payload, concatenado por \n (regra do SSE).
  for (const evento of corpo.split(/\r?\n\r?\n/)) {
    const dados = evento
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (dados.trim()) return JSON.parse(dados);
  }
  throw new Error("SSE_SEM_DADOS");
}

export function extrairResultado(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== "object") throw new Error("ENVELOPE_INVALIDO");
  const env = envelope as { error?: { message?: string }; result?: { content?: Array<{ text?: string }>; isError?: boolean } };
  if (env.error) throw new Error(`MCP_ERRO: ${env.error.message ?? "sem mensagem"}`);
  if (env.result?.isError) throw new Error("MCP_ERRO: ferramenta devolveu isError");
  const texto = env.result?.content?.[0]?.text;
  if (typeof texto !== "string") throw new Error("ENVELOPE_SEM_CONTEUDO");
  return JSON.parse(texto);
}

// Vem do mais recente para o mais antigo: o primeiro é o atendimento atual.
// Só situação/equipe/atendente/datas — nunca nome, contato nem conversas.
export function recortar(resposta: unknown): AtendimentoFicha | null {
  const a = (resposta as { atendimentos?: AtendimentoMcp[] } | null)?.atendimentos?.[0];
  if (!a || typeof a.id !== "string") return null;
  return {
    id: a.id,
    situacao: a.situacao ?? null,
    coluna: a.coluna ?? null,
    equipe: a.equipe ?? null,
    atendente: a.atendente ?? null,
    entrou_em: a.entrouEm ?? null,
    atualizado_em: a.atualizadoEm ?? a.aceitoEm ?? a.entrouEm ?? null,
  };
}

// Só vínculo ativo COM confiança por CPF abre consulta de atendimento. Vínculo
// legado por telefone (confianca 'alta') ou ambíguo não passa por aqui.
// O cliente do Supabase entra por parâmetro para ser testado sem rede.
export interface VinculoConsultavel {
  ulbra_cliente_id: string;
}

export async function vinculoConfirmado(
  sb: any,
  alunoId: string,
): Promise<VinculoConsultavel | null> {
  const { data } = await sb
    .from("ulbra_vinculos")
    .select("ulbra_cliente_id")
    .eq("aluno_id", alunoId)
    .is("desvinculado_em", null)
    .eq("confianca", "alta_cpf")
    .maybeSingle();
  return (data as VinculoConsultavel | null) ?? null;
}

// Cache por isolate: uma abertura de ficha por aluno a cada 5 min no máximo,
// para caber no limite diário da Mensageria sem tabela nova.
export function criarCache(agora: () => number = Date.now) {
  const mapa = new Map<string, { ate: number; valor: AtendimentoFicha | null }>();
  return {
    obter(chave: string) {
      const e = mapa.get(chave);
      if (!e) return undefined;
      if (e.ate <= agora()) { mapa.delete(chave); return undefined; }
      return e.valor;
    },
    guardar(chave: string, valor: AtendimentoFicha | null) {
      mapa.set(chave, { ate: agora() + TTL_MS, valor });
    },
  };
}

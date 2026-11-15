// Recortes do diagnóstico da Mensageria, isolados do Deno para teste.
//
// REGRA DESTE MÓDULO: o que sai daqui é SUPERFÍCIE — escopos, limites e nomes
// de ferramentas. Nunca a credencial, nunca dado de aluno, nunca conversa, e
// nem o nome ou e-mail da pessoa dona do token.

export const MCP_URL = "https://crm.ulbra.ai/api/mcp";

/** Sem este cabeçalho o endpoint devolve 406; com ele, 200 em SSE. */
export const ACCEPT_MCP = "application/json, text/event-stream";

export function lerCorpoMcp(contentType: string | null, corpo: string): unknown {
  if (!(contentType ?? "").toLowerCase().includes("text/event-stream")) {
    return JSON.parse(corpo);
  }
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

/** Devolve `result` do envelope JSON-RPC, ou levanta. */
export function resultadoDoEnvelope(envelope: unknown): Record<string, unknown> {
  if (!envelope || typeof envelope !== "object") throw new Error("ENVELOPE_INVALIDO");
  const env = envelope as {
    error?: { message?: string };
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
  };
  if (env.error) throw new Error("MCP_ERRO");
  if (env.result?.isError) throw new Error("MCP_ERRO");
  if (!env.result || typeof env.result !== "object") throw new Error("ENVELOPE_SEM_RESULTADO");
  return env.result as Record<string, unknown>;
}

/** Em `tools/call`, o retorno da ferramenta vem serializado em content[0].text. */
export function cargaDaFerramenta(result: Record<string, unknown>): unknown {
  const texto = (result.content as Array<{ text?: string }> | undefined)?.[0]?.text;
  if (typeof texto !== "string") throw new Error("ENVELOPE_SEM_CONTEUDO");
  return JSON.parse(texto);
}

export interface AcessoRecortado {
  conexao_tipo: string | null;
  perfis: string[];
  escopos: string[];
  limites: Record<string, unknown>;
}

/**
 * Recorta `meu_acesso`. **Remove `pessoa`** (nome e e-mail do dono do token):
 * para decidir arquitetura basta saber o tipo da conexão, os perfis, os
 * escopos e os limites. `conexao_tipo` importa porque diz se o orçamento é de
 * pessoa ou de serviço.
 */
export function recortarAcesso(carga: unknown): AcessoRecortado {
  const c = (carga ?? {}) as {
    conexao?: { tipo?: unknown };
    pessoa?: { perfis?: unknown };
    perfis?: unknown;
    escopos?: unknown;
    limites?: unknown;
  };
  const perfis = Array.isArray(c.pessoa?.perfis)
    ? (c.pessoa!.perfis as unknown[])
    : Array.isArray(c.perfis)
    ? (c.perfis as unknown[])
    : [];
  return {
    conexao_tipo: typeof c.conexao?.tipo === "string" ? c.conexao.tipo : null,
    perfis: perfis.filter((p): p is string => typeof p === "string"),
    escopos: Array.isArray(c.escopos)
      ? (c.escopos as unknown[]).filter((e): e is string => typeof e === "string")
      : [],
    limites: c.limites && typeof c.limites === "object"
      ? (c.limites as Record<string, unknown>)
      : {},
  };
}

/** Só os NOMES das ferramentas: descrição e esquema não acrescentam aqui. */
export function recortarFerramentas(result: Record<string, unknown>): string[] {
  const tools = result.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => (t as { name?: unknown })?.name)
    .filter((n): n is string => typeof n === "string")
    .sort();
}

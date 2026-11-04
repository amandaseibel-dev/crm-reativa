// Contrato real de listar_atendimentos (medido 2026-11-04): cada item traz
// `entrouEm`, `aceitoEm`, `atualizadoEm` — não `criadoEm`/`updatedAt`.

export const EQUIPE_REATIVA = "Reativa";
export const MCP_URL = "https://crm.ulbra.ai/api/mcp";

export interface AtendimentoMcp {
  id: string;
  cliente?: { id?: string; nome?: string | null } | null;
  situacao?: string;
  coluna?: string | null;
  equipe?: string | null;
  atendente?: string | null;
  entrouEm?: string | null;
  aceitoEm?: string | null;
  atualizadoEm?: string | null;
}

export interface Lead {
  id: string;
  nome: string;
  criado_em: string | null;
}

export function montarChamada(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "listar_atendimentos", arguments: { situacao: "waiting" } },
  };
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

// Só a equipe Reativa, pelo nome canônico; só id, nome e data — sem contato.
export function mapearLeads(resposta: unknown): Lead[] {
  const itens = (resposta as { atendimentos?: AtendimentoMcp[] } | null)?.atendimentos;
  if (!Array.isArray(itens)) return [];
  return itens
    .filter((a) => a && typeof a.id === "string" && a.equipe === EQUIPE_REATIVA)
    .map((a) => ({
      id: a.id,
      nome: a.cliente?.nome || "Sem nome",
      criado_em: a.entrouEm ?? a.atualizadoEm ?? null,
    }));
}

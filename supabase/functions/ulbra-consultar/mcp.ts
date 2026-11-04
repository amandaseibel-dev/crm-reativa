// Contrato real do MCP da Mensageria Ulbra (crm.ulbra.ai/api/mcp), medido em
// 2026-11-04 pela conexão OAuth de gestão. Isolado do Deno para ser testado
// no vitest com a forma exata das respostas.
//
// conferir_duplicidade recebe `contatos: [{telefone|email|cpf}]` (até 20) e
// responde POR POSIÇÃO em `resultados`. O `cliente.id` só vem quando o cliente
// está no escopo da pessoa dona do token; fora do escopo vem só `equipe`.

export const MCP_URL = "https://crm.ulbra.ai/api/mcp";

export type ContatoBusca = { telefone: string } | { cpf: string };

export interface ResultadoDuplicidade {
  posicao: number;
  existe: boolean;
  cliente?: { id: string } | null;
  equipe?: string | null;
  emAtendimento?: { equipe?: string | null } | null;
}

export interface RespostaConferirDuplicidade {
  resultados?: ResultadoDuplicidade[];
}

export type Interpretacao =
  | { status: "vinculado"; ulbra_cliente_id: string; equipe: string | null; em_atendimento: boolean }
  | { status: "nao_encontrado"; motivo: "NAO_ENCONTRADO" | "FORA_DO_ESCOPO" }
  | { status: "erro"; motivo: "RESPOSTA_INVALIDA" };

export function montarChamada(contato: ContatoBusca, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "conferir_duplicidade", arguments: { contatos: [contato] } },
  };
}

// Envelope JSON-RPC do MCP: o resultado da ferramenta vem serializado em
// `result.content[0].text`. `error` no envelope é falha da chamada.
export function extrairResultado(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== "object") throw new Error("ENVELOPE_INVALIDO");
  const env = envelope as { error?: { message?: string }; result?: { content?: Array<{ text?: string }>; isError?: boolean } };
  if (env.error) throw new Error(`MCP_ERRO: ${env.error.message ?? "sem mensagem"}`);
  if (env.result?.isError) throw new Error("MCP_ERRO: ferramenta devolveu isError");
  const texto = env.result?.content?.[0]?.text;
  if (typeof texto !== "string") throw new Error("ENVELOPE_SEM_CONTEUDO");
  return JSON.parse(texto);
}

export function interpretar(resposta: unknown): Interpretacao {
  const r = (resposta as RespostaConferirDuplicidade | null)?.resultados?.[0];
  if (!r || typeof r.existe !== "boolean") return { status: "erro", motivo: "RESPOSTA_INVALIDA" };
  if (r.cliente?.id) {
    return {
      status: "vinculado",
      ulbra_cliente_id: r.cliente.id,
      equipe: r.equipe ?? null,
      em_atendimento: !!r.emAtendimento,
    };
  }
  // `existe: true` sem `cliente` e sem `equipe` foi observado para telefone
  // inexistente (2026-11-04): não é prova de cadastro, trata-se como ausente.
  if (r.existe && r.equipe) return { status: "nao_encontrado", motivo: "FORA_DO_ESCOPO" };
  return { status: "nao_encontrado", motivo: "NAO_ENCONTRADO" };
}

export function escolherContato(aluno: { telefone?: string | null; cpf?: string | null }):
  | { contato: ContatoBusca; origem: "telefone" | "cpf"; telefone_e164: string | null }
  | { erro: "SEM_TELEFONE" | "TELEFONE_MALFORMADO" } {
  const tel = (aluno.telefone ?? "").replace(/\D/g, "");
  if (tel.length >= 10 && tel.length <= 13) {
    return { contato: { telefone: tel }, origem: "telefone", telefone_e164: `+55${tel.replace(/^55/, "")}` };
  }
  const cpf = (aluno.cpf ?? "").replace(/\D/g, "");
  if (cpf.length === 11) return { contato: { cpf }, origem: "cpf", telefone_e164: null };
  return { erro: tel ? "TELEFONE_MALFORMADO" : "SEM_TELEFONE" };
}

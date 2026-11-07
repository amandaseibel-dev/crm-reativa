// Contrato real do MCP da Mensageria Ulbra (crm.ulbra.ai/api/mcp), medido em
// 2026-11-04 pela conexão OAuth de gestão. Isolado do Deno para ser testado
// no vitest com a forma exata das respostas.
//
// conferir_duplicidade recebe `contatos: [{telefone|email|cpf}]` (até 20) e
// responde POR POSIÇÃO em `resultados`. O `cliente.id` só vem quando o cliente
// está no escopo da pessoa dona do token; fora do escopo vem só `equipe`.
//
// ---------------------------------------------------------------------------
// POR QUE AS DUAS CHAVES VÃO NA MESMA CHAMADA (04/11/2026)
//
// `contatos` aceita até 20 posições por chamada, e o limite medido da
// Mensageria é por CHAMADA (15/min por conexão, 500/dia por pessoa), não por
// posição. Então perguntar telefone E CPF juntos custa exatamente o mesmo que
// perguntar só o telefone: 1 chamada. Não há orçamento a economizar aqui — o
// que existe é a confirmação cruzada de graça, e é ela que separa um vínculo
// provado de um palpite por telefone de parente.

export const MCP_URL = "https://crm.ulbra.ai/api/mcp";

export type ContatoBusca = { telefone: string } | { cpf: string };

/** Qual chave de identidade originou uma posição da chamada. */
export type Chave = "telefone" | "cpf";

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

/** O que o aluno oferece como chave de identidade, já normalizado. */
export interface ChavesAluno {
  telefone?: string;
  telefone_e164?: string | null;
  cpf?: string;
}

export type MontagemChaves =
  | { chaves: ChavesAluno; ordem: Chave[] }
  | { erro: "SEM_CHAVE" | "TELEFONE_MALFORMADO" };

/**
 * Normaliza telefone e CPF do aluno e devolve a ORDEM em que entram em
 * `contatos`. Sem nenhuma chave utilizável não há consulta a fazer.
 *
 * CPF com 11 dígitos é chave; telefone só entra entre 10 e 13 dígitos. Um
 * telefone presente mas malformado NÃO é silenciado quando é a única chave:
 * o aluno fica sem consulta e o motivo é dito.
 */
export function montarChaves(aluno: { telefone?: string | null; cpf?: string | null }): MontagemChaves {
  const telBruto = (aluno.telefone ?? "").replace(/\D/g, "");
  const cpf = (aluno.cpf ?? "").replace(/\D/g, "");

  const chaves: ChavesAluno = {};
  const ordem: Chave[] = [];

  const telValido = telBruto.length >= 10 && telBruto.length <= 13;
  if (telValido) {
    chaves.telefone = telBruto;
    chaves.telefone_e164 = `+55${telBruto.replace(/^55/, "")}`;
    ordem.push("telefone");
  }
  if (cpf.length === 11) {
    chaves.cpf = cpf;
    ordem.push("cpf");
  }

  if (ordem.length === 0) {
    return { erro: telBruto ? "TELEFONE_MALFORMADO" : "SEM_CHAVE" };
  }
  return { chaves, ordem };
}

export function montarChamada(contato: ContatoBusca, id = 1) {
  return montarChamadaMulti([contato], id);
}

/** Uma chamada, N posições. `contatos` aceita até 20 (limite medido). */
export function montarChamadaMulti(contatos: ContatoBusca[], id = 1) {
  if (contatos.length === 0 || contatos.length > 20) {
    throw new Error("CONTATOS_FORA_DO_LIMITE");
  }
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "conferir_duplicidade", arguments: { contatos } },
  };
}

/** Monta os `contatos` na ordem declarada por `montarChaves`. */
export function contatosDeChaves(chaves: ChavesAluno, ordem: Chave[]): ContatoBusca[] {
  return ordem.map((k) =>
    k === "telefone" ? { telefone: chaves.telefone! } : { cpf: chaves.cpf! }
  );
}

// Envelope JSON-RPC do MCP: o resultado da ferramenta vem serializado em
// `result.content[0].text`. `error` no envelope é falha da chamada.
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

/** Interpreta UMA posição de `resultados`. */
export function interpretarResultado(r: ResultadoDuplicidade | undefined | null): Interpretacao {
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

export function interpretar(resposta: unknown): Interpretacao {
  return interpretarResultado((resposta as RespostaConferirDuplicidade | null)?.resultados?.[0]);
}

export type InterpretacaoPorChave =
  | { ok: true; porChave: Record<Chave, Interpretacao | undefined> }
  | { ok: false; motivo: "RESPOSTA_INVALIDA" };

/**
 * Casa `resultados[]` com a ORDEM pedida usando o campo `posicao` — nunca a
 * ordem do array. A doc da ferramenta diz "responde POR POSIÇÃO"; confiar na
 * ordem de chegada é o jeito de trocar o resultado do telefone pelo do CPF e
 * gravar vínculo no aluno errado sem nenhum erro aparecer.
 *
 * Falha FECHADO quando: não é array, falta uma posição pedida, uma posição
 * vem repetida, ou vem posição que não foi pedida.
 */
export function interpretarPorChave(resposta: unknown, ordem: Chave[]): InterpretacaoPorChave {
  const resultados = (resposta as RespostaConferirDuplicidade | null)?.resultados;
  if (!Array.isArray(resultados)) return { ok: false, motivo: "RESPOSTA_INVALIDA" };
  if (resultados.length !== ordem.length) return { ok: false, motivo: "RESPOSTA_INVALIDA" };

  const porPosicao = new Map<number, ResultadoDuplicidade>();
  for (const r of resultados) {
    const p = r?.posicao;
    if (typeof p !== "number" || !Number.isInteger(p)) return { ok: false, motivo: "RESPOSTA_INVALIDA" };
    if (porPosicao.has(p)) return { ok: false, motivo: "RESPOSTA_INVALIDA" };
    porPosicao.set(p, r);
  }

  // A numeração de `posicao` em chamada de DUAS chaves nunca foi medida contra
  // a Mensageria (o contrato de 04/11/2026 só tem resposta de uma posição, com
  // `posicao: 0`). Então aceita as duas bases possíveis, e SÓ elas:
  //
  //   conjunto {0..n-1}  -> base 0
  //   conjunto {1..n}    -> base 1
  //
  // Não é adivinhação: os dois conjuntos nunca são o mesmo — base 0 exige a
  // posição 0 presente e base 1 exige que ela não esteja —, então a base é
  // DETERMINADA pelo conjunto recebido, não escolhida. (Eles se sobrepõem:
  // {0,1} e {1,2} compartilham o 1. Não importa; quem decide é o 0.)
  // Qualquer outro conjunto
  // (buraco, posição fora da faixa, posição repetida) FALHA FECHADO — e falhar
  // fechado aqui significa não gravar vínculo nenhum, nunca gravar o errado.
  const posicoes = [...porPosicao.keys()].sort((a, b) => a - b);
  const esperado = (base: number) => ordem.every((_, i) => posicoes[i] === base + i);
  const base = esperado(0) ? 0 : esperado(1) ? 1 : null;
  if (base === null) return { ok: false, motivo: "RESPOSTA_INVALIDA" };

  const porChave: Record<Chave, Interpretacao | undefined> = { telefone: undefined, cpf: undefined };
  for (let i = 0; i < ordem.length; i++) {
    const interp = interpretarResultado(porPosicao.get(base + i));
    if (interp.status === "erro") return { ok: false, motivo: "RESPOSTA_INVALIDA" };
    porChave[ordem[i]] = interp;
  }

  // -------------------------------------------------------------------------
  // BASE 1 É CONVENÇÃO NÃO CONFIRMADA — e por isso só vale quando não pode
  // mudar a decisão.
  //
  // O que foi medido em 04/11/2026 é `posicao: 0` em resposta de UMA posição.
  // Base 1 é inferência. E a inferência importa: se as posições estiverem
  // trocadas em relação ao pedido, o resultado "telefone achou X, CPF não
  // achou" é lido como "CPF confirmou X, telefone não achou" — e o primeiro
  // BLOQUEIA enquanto o segundo GRAVA. Seria o falso positivo exato que esta
  // correção existe para fechar, produzido por um detalhe que ninguém mediu.
  //
  // Então, em base 1, só segue adiante a resposta cujo mapeamento é
  // indiferente: todas as chaves com o MESMO cliente, ou nenhuma com cliente.
  // Qualquer assimetria falha FECHADO — nenhum vínculo é gravado.
  //
  // Base 0 segue aceita como está: é a convenção medida e é a que a própria
  // ferramenta documenta ("responde POR POSIÇÃO", posições do array pedido).
  // -------------------------------------------------------------------------
  if (base === 1) {
    const ids = ordem.map((k) => {
      const i = porChave[k];
      return i && i.status === "vinculado" ? i.ulbra_cliente_id : null;
    });
    const distintos = new Set(ids);
    if (distintos.size > 1) return { ok: false, motivo: "RESPOSTA_INVALIDA" };
  }

  return { ok: true, porChave };
}

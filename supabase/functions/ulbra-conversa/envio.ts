// ===========================================================================
// ENVIO DE RESPOSTA pelo ReATIVA, com a conexão INDIVIDUAL do operador.
//
// Ordem, e ela não é intercambiável:
//  1. validação do pedido (texto, identidade confirmada, carteira/atendimento, conexão);
//  2. idempotência: um clique = uma chave. Repetir o clique devolve o resultado
//     já gravado e NÃO envia de novo;
//  3. envio com tempo limite. Resultado desconhecido (timeout, queda) vira
//     FALHA_INCERTA e NÃO é reenviado às cegas: a mensagem pode ter saído.
//
// Lógica pura. Repositório e provedor entram por injeção.
// ===========================================================================
import { garantirConexao, type ProvedorOAuth, type RegistroConexao } from "./conexao.ts";

/** Limites do contrato da ferramenta `enviar_mensagem_whatsapp` (medido no schema). */
export const TEXTO_MAX = 4096;
export const CHAVE_MIN = 8;
export const CHAVE_MAX = 80;
/** Janela de atendimento: o cliente precisa ter escrito nas últimas 24 h. Fora dela, só template. */
export const JANELA_MS = 24 * 60 * 60 * 1000;
export const ATENDIMENTO_RE = /^[a-f0-9]{24}$/;
export const TIMEOUT_ENVIO_MS = 15_000;

export type StatusEnvio = "PENDENTE" | "ENVIANDO" | "ENVIADO" | "RECUSADO" | "FALHA_INCERTA";

export interface Envio {
  chave: string;
  operador_email: string;
  atendimento_id: string;
  texto: string;
  status: StatusEnvio;
  ulbra_mensagem_id: string | null;
  motivo: string | null;
  criado_em_ms: number;
}

export interface PedidoEnvio {
  operador: string;
  atendimento_id: string;
  texto: string;
  /** Gerada pelo cliente uma vez por clique. Repetição com a mesma chave não reenvia. */
  chave: string;
  /** Último horário em que o CLIENTE escreveu, para checar a janela de 24 h. */
  ultima_mensagem_cliente_em_ms: number | null;
  agora_ms: number;
  /** Quem é o dono da carteira do aluno (casos.operador_email), se houver. */
  dono_carteira: string | null;
  /** Responsável pelo atendimento no ReATIVA (ulbra_atendimentos.responsavel_email), se houver. */
  responsavel_atendimento: string | null;
  identidade_confirmada: boolean;
  /**
   * Atendente do atendimento NA MENSAGERIA (campo `atendente` de listar/consultar_atendimento).
   * Null quando não foi lido: sem ele o envio é bloqueado (fail-closed).
   */
  atendente_ulbra: string | null;
  /** Conta conectada do operador (pessoa_id e pessoa_nome de meu_acesso). */
  conta_conectada: { pessoa_id: string | null; pessoa_nome: string | null } | null;
  /** Template usado FORA da janela de 24 h. Só aceito se estiver na lista aprovada. */
  template: TemplateEnvio | null;
}

export interface TemplateEnvio {
  nome: string;
  /** Valores das variáveis, na ordem do template aprovado. */
  variaveis: string[];
}

export interface ProvedorEnvio {
  enviar(
    pedido: {
      access_token: string;
      atendimento_id: string;
      texto: string;
      chave: string;
      template: TemplateEnvio | null;
    },
  ): Promise<{ ulbra_mensagem_id: string }>;
}

/**
 * Lê o template do corpo da requisição. Ausente = null (texto livre). Presente mas malformado
 * vira template com nome vazio, que a validação bloqueia: nunca cai em texto livre em silêncio.
 */
export function templateDoCorpo(v: unknown): TemplateEnvio | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") return { nome: "", variaveis: [] };
  const o = v as { nome?: unknown; variaveis?: unknown };
  const nome = typeof o.nome === "string" ? o.nome.trim() : "";
  const variaveis = Array.isArray(o.variaveis) && o.variaveis.every((x) => typeof x === "string") ? (o.variaveis as string[]) : [];
  if (Array.isArray(o.variaveis) && variaveis.length === 0 && o.variaveis.length > 0) return { nome: "", variaveis: [] };
  return { nome, variaveis };
}

/**
 * Lista local de templates aprovados (ULBRA_TEMPLATES_APROVADOS, separada por vírgula).
 * Só RESTRINGE o uso: não substitui a aprovação nem a disponibilidade informadas pela ULBRA.
 */
export function templatesAprovadosDoAmbiente(): string[] {
  const bruto = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get("ULBRA_TEMPLATES_APROVADOS") ?? "";
  return bruto.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/** Normaliza para comparar identidade: minúsculas, sem espaços nas pontas e com espaços colapsados. */
export function normalizarIdentidade(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** A Mensageria recusou a mensagem (regra de negócio). Não é falha de rede. */
export class RecusadoPelaUlbra extends Error {}

export interface RepositorioEnvio {
  buscar(operador: string, chave: string): Promise<Envio | null>;
  /** Insere se a chave ainda não existe. Devolve false se outra requisição já a criou. */
  inserirSeNovo(envio: Envio): Promise<boolean>;
  atualizar(operador: string, chave: string, campos: Partial<Envio>): Promise<void>;
}

export interface DependenciasEnvio {
  repositorio: RepositorioEnvio;
  provedorOAuth: ProvedorOAuth;
  provedorEnvio: ProvedorEnvio;
  conexao: RegistroConexao | null;
  /**
   * Só `true` no caminho de envio REAL explicitamente confirmado (roteiro aprovado).
   * Sem isso, o módulo bloqueia antes de qualquer chamada ao provedor. Preparação
   * e testes nunca passam true.
   */
  envioRealConfirmado: boolean;
  /** Nomes de template aprovados para uso fora da janela. Vazia = nenhum template é aceito. */
  templatesAprovados: readonly string[];
  agora: () => number;
  timeoutMs?: number;
}

export type ResultadoEnvio =
  | { situacao: "BLOQUEADO"; motivos: string[] }
  | { situacao: "JA_PROCESSADO"; envio: Envio }
  | { situacao: "PROCESSADO"; envio: Envio };

/** Valida o pedido antes de tocar em qualquer coisa. Devolve a lista de motivos. */
export function validarPedido(p: PedidoEnvio): string[] {
  const motivos: string[] = [];
  const texto = p.texto.trim();
  const dentroDaJanela = p.ultima_mensagem_cliente_em_ms !== null && p.agora_ms - p.ultima_mensagem_cliente_em_ms <= JANELA_MS;
  // Texto livre só dentro da janela. Template é o caminho fora dela (e pode ir junto com texto, se a janela estiver aberta).
  if (p.template === null && texto.length === 0) motivos.push("TEXTO_VAZIO");
  if (texto.length > TEXTO_MAX) motivos.push("TEXTO_LONGO");
  if (p.template === null && !dentroDaJanela) motivos.push("JANELA_FECHADA_USAR_TEMPLATE");
  if (p.template !== null) {
    if (!p.template.nome.trim()) motivos.push("TEMPLATE_SEM_NOME");
    if (p.template.variaveis.some((v) => typeof v !== "string" || v.trim() === "")) motivos.push("TEMPLATE_VARIAVEL_VAZIA");
  }
  if (p.chave.length < CHAVE_MIN || p.chave.length > CHAVE_MAX) motivos.push("CHAVE_INVALIDA");
  if (!ATENDIMENTO_RE.test(p.atendimento_id)) motivos.push("ATENDIMENTO_INVALIDO");
  if (!p.identidade_confirmada) motivos.push("IDENTIDADE_NAO_CONFIRMADA");
  const operador = p.operador.toLowerCase();
  const eDono = (p.dono_carteira ?? "").toLowerCase() === operador;
  const eResponsavel = (p.responsavel_atendimento ?? "").toLowerCase() === operador;
  if (!eDono && !eResponsavel) motivos.push("SEM_PERMISSAO_NA_CONVERSA");
  // Identidade do atendente: a Mensageria só aceita envio da conta atendente. Fail-closed:
  // sem o atendente lido, ou sem a conta conectada identificada, não há como provar.
  const atendente = normalizarIdentidade(p.atendente_ulbra);
  const conta = p.conta_conectada;
  const contaIds = [normalizarIdentidade(conta?.pessoa_id), normalizarIdentidade(conta?.pessoa_nome)].filter((x) => x !== "");
  if (atendente === "") motivos.push("ATENDENTE_ULBRA_NAO_LIDO");
  else if (contaIds.length === 0) motivos.push("CONTA_CONECTADA_NAO_IDENTIFICADA");
  else if (!contaIds.includes(atendente)) motivos.push("ATENDENTE_DIFERENTE_DA_CONTA_CONECTADA");
  return motivos;
}

export async function enviarResposta(
  pedido: PedidoEnvio,
  deps: DependenciasEnvio,
): Promise<ResultadoEnvio> {
  if (!deps.envioRealConfirmado) return { situacao: "BLOQUEADO", motivos: ["ENVIO_REAL_NAO_CONFIRMADO"] };
  const motivos = validarPedido(pedido);
  if (pedido.template !== null && !deps.templatesAprovados.includes(pedido.template.nome)) {
    motivos.push("TEMPLATE_NAO_APROVADO");
  }
  if (motivos.length > 0) return { situacao: "BLOQUEADO", motivos };

  // Autoria: só a conexão DO PRÓPRIO operador. Nunca credencial central.
  const agora = deps.agora();
  if (!deps.conexao || deps.conexao.operador_email.toLowerCase() !== pedido.operador.toLowerCase()) {
    return { situacao: "BLOQUEADO", motivos: ["SEM_CONEXAO_INDIVIDUAL"] };
  }
  // A Mensageria só aceita envio da conta atendente: sem identidade da pessoa do token, não há prova de autoria.
  if (!deps.conexao.pessoa_id) {
    return { situacao: "BLOQUEADO", motivos: ["CONEXAO_SEM_IDENTIDADE"] };
  }
  const conn = await garantirConexao(deps.conexao, deps.provedorOAuth, agora);
  if (!conn.ok) return { situacao: "BLOQUEADO", motivos: [conn.motivo] };

  // Idempotência: a mesma chave devolve o que já foi gravado, sem enviar.
  const existente = await deps.repositorio.buscar(pedido.operador, pedido.chave);
  if (existente) return { situacao: "JA_PROCESSADO", envio: existente };

  const texto = pedido.texto.trim();
  const novo: Envio = {
    chave: pedido.chave,
    operador_email: pedido.operador,
    atendimento_id: pedido.atendimento_id,
    texto,
    status: "PENDENTE",
    ulbra_mensagem_id: null,
    motivo: null,
    criado_em_ms: agora,
  };
  const inserido = await deps.repositorio.inserirSeNovo(novo);
  if (!inserido) {
    const outro = await deps.repositorio.buscar(pedido.operador, pedido.chave);
    return { situacao: "JA_PROCESSADO", envio: outro ?? novo };
  }

  await deps.repositorio.atualizar(pedido.operador, pedido.chave, { status: "ENVIANDO" });
  const limite = deps.timeoutMs ?? TIMEOUT_ENVIO_MS;
  try {
    const resposta = await comTimeout(
      deps.provedorEnvio.enviar({
        access_token: conn.registro.access_token,
        atendimento_id: pedido.atendimento_id,
        texto,
        chave: pedido.chave,
        template: pedido.template,
      }),
      limite,
    );
    await deps.repositorio.atualizar(pedido.operador, pedido.chave, {
      status: "ENVIADO",
      ulbra_mensagem_id: resposta.ulbra_mensagem_id,
    });
  } catch (e) {
    if (e instanceof RecusadoPelaUlbra) {
      await deps.repositorio.atualizar(pedido.operador, pedido.chave, { status: "RECUSADO", motivo: e.message });
    } else {
      // Timeout ou queda: a mensagem pode ter saído. Não se reenvia sozinho.
      await deps.repositorio.atualizar(pedido.operador, pedido.chave, {
        status: "FALHA_INCERTA",
        motivo: (e as Error).message,
      });
    }
  }
  const final = await deps.repositorio.buscar(pedido.operador, pedido.chave);
  return { situacao: "PROCESSADO", envio: final! };
}

function comTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("TIMEOUT_ENVIO")), ms);
  });
  return Promise.race([p, limite]).finally(() => clearTimeout(timer));
}

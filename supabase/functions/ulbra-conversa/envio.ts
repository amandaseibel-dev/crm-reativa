// ===========================================================================
// ENVIO DE RESPOSTA pelo ReATIVA, com a conexão INDIVIDUAL do operador.
// Só TEXTO LIVRE, dentro da janela de 24 h. Templates ficam fora desta entrega
// (recusados no backend e desativados no frontend).
//
// Ordem, e ela não é intercambiável (a prévia registrada fica em previa.ts):
//  1. validação do pedido (texto, identidade, atendente, responsabilidade, janela, conexão);
//  2. idempotência: uma chave = um envio. Repetir a chave devolve o que já foi gravado;
//  3. envio com tempo limite. Resultado desconhecido (timeout, queda) vira
//     FALHA_INCERTA e NÃO é reenviado às cegas: a mensagem pode ter saído.
//
// Lógica pura. Repositório e provedor entram por injeção.
// ===========================================================================
import { garantirConexao, type ProvedorOAuth, type RegistroConexao } from "./conexao.ts";

/** Limites da mensagem. Espelham os CHECK da migration (texto 1..4096, chave 8..80). */
export const TEXTO_MAX = 4096;
export const CHAVE_MIN = 8;
export const CHAVE_MAX = 80;
/** Janela de atendimento: o cliente precisa ter escrito nas últimas 24 h. */
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
  previa_id: string | null;
}

export interface PedidoEnvio {
  operador: string;
  atendimento_id: string;
  /** Cliente da Mensageria dono do atendimento, segundo o espelho. Null = não identificado. */
  ulbra_cliente_id: string | null;
  texto: string;
  /** Gerada pelo cliente uma vez por clique. Repetição com a mesma chave não reenvia. */
  chave: string;
  /** Último horário em que o CLIENTE escreveu, para checar a janela de 24 h. */
  ultima_mensagem_cliente_em_ms: number | null;
  agora_ms: number;
  /** Dono da carteira do aluno (casos.operador_email), se houver e se for um só. */
  dono_carteira: string | null;
  /** Responsável pelo atendimento no ReATIVA (ulbra_atendimentos.responsavel_email), se houver. */
  responsavel_atendimento: string | null;
  identidade_confirmada: boolean;
  /**
   * Atendente do atendimento NA MENSAGERIA. Null quando não foi lido: sem ele o envio é bloqueado.
   * Fonte NÃO definida. Candidato: ulbra_conversas.responsavel_ulbra, equivalência NÃO comprovada.
   * Enquanto não houver fonte confirmada pelo contrato real, o envio fica bloqueado.
   */
  atendente_ulbra: string | null;
  /** Conta conectada do operador (pessoa_id e pessoa_nome de meu_acesso). */
  conta_conectada: { pessoa_id: string | null; pessoa_nome: string | null } | null;
}

export interface ProvedorEnvio {
  enviar(
    pedido: { access_token: string; atendimento_id: string; texto: string; chave: string },
  ): Promise<{ ulbra_mensagem_id: string }>;
}

/** A Mensageria recusou a mensagem (regra de negócio). Não é falha de rede. */
export class RecusadoPelaUlbra extends Error {}

export interface RepositorioEnvio {
  buscar(operador: string, chave: string): Promise<Envio | null>;
  /**
   * Insere se a chave ainda não existe. Devolve false SOMENTE quando a chave já existe.
   * Qualquer outra falha de gravação deve lançar: nunca vira "já processado".
   */
  inserirSeNovo(envio: Envio): Promise<"NOVO" | "CHAVE_EXISTENTE" | "TEXTO_EM_ABERTO">;
  atualizar(operador: string, chave: string, campos: Partial<Envio>): Promise<void>;
  /** Há envio em FALHA_INCERTA para este atendimento e este texto (qualquer operador). */
  existeFalhaIncerta(atendimento_id: string, texto: string): Promise<boolean>;
}

export interface DependenciasEnvio {
  repositorio: RepositorioEnvio;
  provedorOAuth: ProvedorOAuth;
  provedorEnvio: ProvedorEnvio;
  conexao: RegistroConexao | null;
  /**
   * Só `true` no caminho de envio REAL explicitamente confirmado (roteiro aprovado).
   * Sem isso, o módulo bloqueia antes de qualquer chamada ao provedor.
   */
  envioRealConfirmado: boolean;
  agora: () => number;
  timeoutMs?: number;
}

export type ResultadoEnvio =
  | { situacao: "BLOQUEADO"; motivos: string[] }
  | { situacao: "JA_PROCESSADO"; envio: Envio }
  | { situacao: "PROCESSADO"; envio: Envio };

/** Normaliza para comparar identidade: minúsculas, sem espaços nas pontas e com espaços colapsados. */
export function normalizarIdentidade(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** SHA-256 (hex) do texto já sem espaços nas pontas. É o que a prévia guarda e a confirmação confere. */
export async function hashConteudo(texto: string): Promise<string> {
  const bytes = new TextEncoder().encode(texto.trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Valida o pedido antes de tocar em qualquer coisa. Devolve a lista de motivos. */
export function validarPedido(p: PedidoEnvio): string[] {
  const motivos: string[] = [];
  const texto = p.texto.trim();
  if (texto.length === 0) motivos.push("TEXTO_VAZIO");
  if (texto.length > TEXTO_MAX) motivos.push("TEXTO_LONGO");
  if (p.chave.length < CHAVE_MIN || p.chave.length > CHAVE_MAX) motivos.push("CHAVE_INVALIDA");
  if (!ATENDIMENTO_RE.test(p.atendimento_id)) motivos.push("ATENDIMENTO_INVALIDO");
  if (!p.identidade_confirmada) motivos.push("IDENTIDADE_NAO_CONFIRMADA");
  const operador = p.operador.toLowerCase();
  const eDono = (p.dono_carteira ?? "").toLowerCase() === operador;
  const eResponsavel = (p.responsavel_atendimento ?? "").toLowerCase() === operador;
  if (!eDono && !eResponsavel) motivos.push("SEM_PERMISSAO_NA_CONVERSA");
  if (p.ultima_mensagem_cliente_em_ms === null || p.agora_ms - p.ultima_mensagem_cliente_em_ms > JANELA_MS) {
    motivos.push("JANELA_FECHADA");
  }
  // Identidade do atendente: a Mensageria só aceita envio da conta atendente. Fail-closed.
  const atendente = normalizarIdentidade(p.atendente_ulbra);
  const contaIds = [normalizarIdentidade(p.conta_conectada?.pessoa_id), normalizarIdentidade(p.conta_conectada?.pessoa_nome)].filter((x) => x !== "");
  if (atendente === "") motivos.push("ATENDENTE_ULBRA_NAO_LIDO");
  else if (contaIds.length === 0) motivos.push("CONTA_CONECTADA_NAO_IDENTIFICADA");
  else if (!contaIds.includes(atendente)) motivos.push("ATENDENTE_DIFERENTE_DA_CONTA_CONECTADA");
  return motivos;
}

/**
 * Envio de texto livre. `previaId` (quando houver) fica gravado no envio; o banco impede
 * que a mesma prévia gere dois envios.
 */
export async function enviarResposta(
  pedido: PedidoEnvio,
  deps: DependenciasEnvio,
  previaId: string | null = null,
): Promise<ResultadoEnvio> {
  if (!deps.envioRealConfirmado) return { situacao: "BLOQUEADO", motivos: ["ENVIO_REAL_NAO_CONFIRMADO"] };
  const motivos = validarPedido(pedido);
  if (motivos.length > 0) return { situacao: "BLOQUEADO", motivos };

  // Autoria: só a conexão DO PRÓPRIO operador. Nunca credencial central.
  const agora = deps.agora();
  if (!deps.conexao || deps.conexao.operador_email.toLowerCase() !== pedido.operador.toLowerCase()) {
    return { situacao: "BLOQUEADO", motivos: ["SEM_CONEXAO_INDIVIDUAL"] };
  }
  if (!deps.conexao.pessoa_id) {
    return { situacao: "BLOQUEADO", motivos: ["CONEXAO_SEM_IDENTIDADE"] };
  }
  const conn = await garantirConexao(deps.conexao, deps.provedorOAuth, agora);
  if (!conn.ok) return { situacao: "BLOQUEADO", motivos: [conn.motivo] };

  const texto = pedido.texto.trim();
  // Idempotência ligada ao conteúdo: a chave só vale para o MESMO atendimento e o MESMO texto.
  const existente = await deps.repositorio.buscar(pedido.operador, pedido.chave);
  if (existente) {
    if (existente.atendimento_id !== pedido.atendimento_id || existente.texto !== texto) {
      return { situacao: "BLOQUEADO", motivos: ["CHAVE_COM_OUTRO_CONTEUDO"] };
    }
    return { situacao: "JA_PROCESSADO", envio: existente };
  }
  // Falha incerta não reenvia, nem com outra chave: a mensagem pode ter saído.
  if (await deps.repositorio.existeFalhaIncerta(pedido.atendimento_id, texto)) {
    return { situacao: "BLOQUEADO", motivos: ["FALHA_INCERTA_PENDENTE_CONFERENCIA"] };
  }
  const novo: Envio = {
    chave: pedido.chave,
    operador_email: pedido.operador,
    atendimento_id: pedido.atendimento_id,
    texto,
    status: "PENDENTE",
    ulbra_mensagem_id: null,
    motivo: null,
    criado_em_ms: agora,
    previa_id: previaId,
  };
  // Se a gravação falhar, a exceção sobe: não há envio e não há "já processado" falso.
  const insercao = await deps.repositorio.inserirSeNovo(novo);
  if (insercao === "CHAVE_EXISTENTE") {
    const outro = await deps.repositorio.buscar(pedido.operador, pedido.chave);
    if (!outro) throw new Error("ENVIO_SEM_REGISTRO");
    return { situacao: "JA_PROCESSADO", envio: outro };
  }
  if (insercao === "TEXTO_EM_ABERTO") {
    // Índice único parcial: já há envio PENDENTE, ENVIANDO ou FALHA_INCERTA com este texto neste atendimento.
    return { situacao: "BLOQUEADO", motivos: ["ENVIO_EM_ABERTO_MESMO_TEXTO"] };
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
  if (!final) throw new Error("ENVIO_SEM_REGISTRO");
  return { situacao: "PROCESSADO", envio: final };
}

function comTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("TIMEOUT_ENVIO")), ms);
  });
  return Promise.race([p, limite]).finally(() => clearTimeout(timer));
}

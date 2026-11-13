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
    motivos.push("JANELA_FECHADA_USAR_TEMPLATE");
  }
  return motivos;
}

export async function enviarResposta(
  pedido: PedidoEnvio,
  deps: DependenciasEnvio,
): Promise<ResultadoEnvio> {
  if (!deps.envioRealConfirmado) return { situacao: "BLOQUEADO", motivos: ["ENVIO_REAL_NAO_CONFIRMADO"] };
  const motivos = validarPedido(pedido);
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

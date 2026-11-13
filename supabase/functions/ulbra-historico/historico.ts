// ===========================================================================
// HISTÓRICO SOMENTE LEITURA da conversa, para a Central ULBRA.
// PREPARADO. Não publicado, não ligado, sem migration aplicada.
//
// Ordem de decisão (cada etapa só roda se a anterior passou):
//  1. identidade: o aluno tem CPF confirmado (aluno_id);
//  2. autorização: o operador é DONO DA CARTEIRA ou RESPONSÁVEL COMPROVADO pelo
//     atendimento, com dados lidos do banco AGORA (não da lista da Central).
//     Poder ver um caso na Central NÃO basta: ver não é responder;
//  3. cache: página já lida nos últimos minutos custa ZERO chamadas;
//  4. saldo: a fotografia do saldo precisa ser recente. Sem saldo, ou com
//     saldo vencido, bloqueia (não presume);
//  5. orçamento atômico: a chamada é RESERVADA no banco (por operador e
//     global, entre instâncias) ANTES de sair. Cada chamada externa conta,
//     inclusive "Carregar anteriores";
//  6. leitura: ler_conversa com a credencial de backend (somente leitura).
//
// Nada é enviado. Nada é gravado com texto. Nenhuma conexão individual é
// usada aqui: a leitura não exige autoria, o envio sim (outra frente).
//
// VALORES PROPOSTOS, NÃO ATIVADOS: LIMITE_OPERADOR_DIA = 20, RESERVA_GLOBAL = 100.
// ===========================================================================
import { permitirLeitura, mapearPagina, type ContextoLeitura, type PaginaMensagens } from "./leitura.ts";

export const LIMITE_OPERADOR_DIA = 20; // PROPOSTA — aguarda decisão da gestão
export const RESERVA_GLOBAL = 100; // PROPOSTA — saldo que o histórico nunca gasta; teto = restam - reserva
export const SALDO_VALIDADE_MS = 15 * 60 * 1000; // PROPOSTA: saldo com mais de 15 min não serve
export const CACHE_VALIDADE_MS = 5 * 60 * 1000;
export const TAMANHO_PAGINA = 20;
/** Teto TOTAL do piloto, somando leituras e a renovação de saldo (meu_acesso). Sem reset diário. */
export const LIMITE_TOTAL_PILOTO = 3;

export interface FotografiaSaldo {
  restam: number;
  em: string; // ISO: quando a ULBRA respondeu meu_acesso
}

export type MotivoBloqueio =
  | "IDENTIDADE_NAO_CONFIRMADA"
  | "SEM_PERMISSAO_NA_CONVERSA"
  | "SALDO_SEM_INFORMACAO"
  | "SALDO_DESATUALIZADO"
  | "LIMITE_OPERADOR_DIA"
  | "RESERVA_GLOBAL"
  | "ULBRA_INDISPONIVEL"
  | "ULBRA_LIMITE"
  | "TETO_PILOTO_ESGOTADO"
  | "CONVERSA_NAO_ENCONTRADA";

export interface Decisao {
  ok: boolean;
  motivo?: MotivoBloqueio;
}

/** Autorização pelos dados do banco. `dono_carteira` e `responsavel_atendimento` devem vir de consulta de hoje. */
export function autorizarHistorico(c: ContextoLeitura): Decisao {
  const p = permitirLeitura(c);
  return p.ok ? { ok: true } : { ok: false, motivo: p.motivo };
}

/** Saldo só vale se foi medido há pouco. Sem medida, ou vencida, bloqueia. */
export function avaliarSaldo(saldo: FotografiaSaldo | null, agoraMs: number): Decisao & { validadeAte?: string } {
  if (!saldo || !Number.isFinite(saldo.restam) || !saldo.em) return { ok: false, motivo: "SALDO_SEM_INFORMACAO" };
  const emMs = Date.parse(saldo.em);
  if (!Number.isFinite(emMs)) return { ok: false, motivo: "SALDO_SEM_INFORMACAO" };
  if (agoraMs - emMs > SALDO_VALIDADE_MS) return { ok: false, motivo: "SALDO_DESATUALIZADO" };
  return { ok: true, validadeAte: new Date(emMs + SALDO_VALIDADE_MS).toISOString() };
}

/** Resultado da reserva atômica no banco (ulbra_historico_reservar). */
export interface ResultadoReserva {
  permitido: boolean;
  usadasOperador: number;
  usadasGlobal: number;
  motivo?: MotivoBloqueio;
}

export interface DependenciasHistorico {
  /** Consulta de hoje: carteira e responsável comprovados para (operador, conversa). */
  consultarPermissao(operador: string, conversaId: string): Promise<ContextoLeitura | null>;
  /** Fotografia do saldo guardada pela coleta (ulbra_sync_estado). */
  lerSaldo(): Promise<FotografiaSaldo | null>;
  /** Reserva atômica no banco: uma chamada externa = uma reserva. */
  reservar(operador: string, quantidade: number, tetoOperador: number, tetoGlobal: number): Promise<ResultadoReserva>;
  /** Chamadas já reservadas em todo o período do piloto (somadas em todos os dias). */
  usoTotal(): Promise<number>;
  /** Chamada real à ULBRA (credencial de backend, somente leitura). */
  lerConversa(conversaId: string, antesDe: string | null, limite: number): Promise<unknown>;
  agora(): number;
}

export type ResultadoHistorico =
  | { ok: true; origem: "cache" | "ulbra"; pagina: PaginaMensagens; chamadas: number; saldoAte: string | null; alcance: string }
  | { ok: false; motivo: MotivoBloqueio };

interface EntradaCache {
  expira: number;
  pagina: PaginaMensagens;
}

/** Cache por conversa+cursor, em memória de UMA instância. É só otimização: o limite vem do banco. */
const cache = new Map<string, EntradaCache>();
/** Pedidos idênticos em curso: um só faz a chamada e os demais esperam o mesmo resultado. */
const emCurso = new Map<string, Promise<ResultadoHistorico>>();

export function limparCacheParaTeste(): void {
  cache.clear();
  emCurso.clear();
}

export async function lerHistoricoSomenteLeitura(
  operador: string,
  conversaId: string,
  antesDe: string | null,
  deps: DependenciasHistorico,
): Promise<ResultadoHistorico> {
  const chave = `${operador}|${conversaId}|${antesDe ?? ""}`;
  const agora = deps.agora();
  const hit = cache.get(chave);
  if (hit && hit.expira > agora) {
    return { ok: true, origem: "cache", pagina: hit.pagina, chamadas: 0, saldoAte: null, alcance: ALCANCE };
  }
  const existente = emCurso.get(chave);
  if (existente) return existente;

  const execucao = executar(operador, conversaId, antesDe, deps, chave);
  emCurso.set(chave, execucao);
  try {
    return await execucao;
  } finally {
    emCurso.delete(chave);
  }
}

/** O que a leitura prova e o que NÃO prova. Vai junto com a resposta. */
export const ALCANCE =
  "comprovado: identidade confirmada, carteira/responsabilidade lidas do banco agora, reserva de chamada feita antes da chamada. NÃO comprovado: que a credencial de backend enxerga toda conversa (404/vazio fica como indisponível), e que a cota é separada da cota de autorização externa da gestão.";

async function executar(
  operador: string,
  conversaId: string,
  antesDe: string | null,
  deps: DependenciasHistorico,
  chave: string,
): Promise<ResultadoHistorico> {
  const contexto = await deps.consultarPermissao(operador, conversaId);
  if (!contexto) return { ok: false, motivo: "SEM_PERMISSAO_NA_CONVERSA" };
  const aut = autorizarHistorico(contexto);
  if (!aut.ok) return { ok: false, motivo: aut.motivo! };
  // Teto do piloto antes de qualquer chamada externa (inclusive meu_acesso).
  if ((await deps.usoTotal()) >= LIMITE_TOTAL_PILOTO) return { ok: false, motivo: "TETO_PILOTO_ESGOTADO" };

  const fotografia = await deps.lerSaldo();
  const saldo = avaliarSaldo(fotografia, deps.agora());
  if (!saldo.ok) return { ok: false, motivo: saldo.motivo! };
  // Teto global do histórico = saldo medido menos a reserva. A reserva nunca é
  // gasta pelo histórico. O saldo é uma fotografia: a coleta também gasta.
  const tetoGlobal = Math.max(0, fotografia!.restam - RESERVA_GLOBAL);

  const reserva = await deps.reservar(operador, 1, LIMITE_OPERADOR_DIA, tetoGlobal);
  if (!reserva.permitido) {
    const motivo: MotivoBloqueio = reserva.motivo
      ?? (reserva.usadasOperador + 1 > LIMITE_OPERADOR_DIA ? "LIMITE_OPERADOR_DIA" : "RESERVA_GLOBAL");
    return { ok: false, motivo };
  }

  let resposta: unknown;
  try {
    resposta = await deps.lerConversa(conversaId, antesDe, TAMANHO_PAGINA);
  } catch (e) {
    // A reserva já foi gasta: conta como chamada. Não repete automaticamente.
    // 429 é parada: a função não tenta de novo e a resposta diz o motivo.
    return { ok: false, motivo: (e as Error).message === "ULBRA_LIMITE" ? "ULBRA_LIMITE" : "ULBRA_INDISPONIVEL" };
  }
  const pagina = mapearPagina(resposta);
  cache.set(chave, { expira: deps.agora() + CACHE_VALIDADE_MS, pagina });
  return { ok: true, origem: "ulbra", pagina, chamadas: 1, saldoAte: saldo.validadeAte ?? null, alcance: ALCANCE };
}

export const TAMANHO = TAMANHO_PAGINA;

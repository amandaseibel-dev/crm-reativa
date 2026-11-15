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
export const TETO_HISTORICO_DIA = 150; // PROPOSTA — teto TOTAL do histórico no dia (todos os operadores), mesmo com saldo alto
export const SALDO_VALIDADE_MS = 15 * 60 * 1000; // PROPOSTA: saldo com mais de 15 min não serve
export const CACHE_VALIDADE_MS = 5 * 60 * 1000;
export const TAMANHO_PAGINA = 20;

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
  | "ULBRA_BLOQUEADA"
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

// Dia do orçamento: calendário de São Paulo (a cota da ULBRA não vira à meia-noite UTC).
export function diaDoOrcamento(agoraMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(agoraMs));
}

// Bloqueio compartilhado após 429. Retry-After só é usado quando a ULBRA o informa.
// Retry-After (RFC 9110): segundos OU data HTTP. Devolve segundos restantes, ou null quando não interpretável (sem prazo).
export function parseRetryAfter(valor: string | null, agoraMs: number): number | null {
  if (valor === null) return null;
  const v = valor.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const ateMs = Date.parse(v);
  if (!Number.isFinite(ateMs)) return null;
  return Math.max(0, Math.ceil((ateMs - agoraMs) / 1000));
}

export interface EstadoBloqueio { ativo: boolean; ateMs: number | null; semPrazo: boolean }

export interface DependenciasHistorico {
  /** Consulta de hoje: carteira e responsável comprovados para (operador, conversa). */
  consultarPermissao(operador: string, conversaId: string): Promise<ContextoLeitura | null>;
  /** Fotografia do saldo guardada pela coleta (ulbra_sync_estado). Não chama a ULBRA. */
  lerSaldo(): Promise<FotografiaSaldo | null>;
  /** Renovação do saldo: 1 chamada meu_acesso. NÃO reserva: quem chama já reservou. */
  renovarSaldo(): Promise<FotografiaSaldo | null>;
  /** Estado do bloqueio compartilhado (após 429). */
  lerBloqueio(): Promise<EstadoBloqueio>;
  /** Grava o bloqueio após 429. retryAfterSegundos = null quando a ULBRA não informou prazo. */
  registrarBloqueio(retryAfterSegundos: number | null): Promise<void>;
  /** Reserva atômica no banco: uma chamada externa = uma reserva. */
  reservar(operador: string, quantidade: number, tetoOperador: number, tetoGlobal: number): Promise<ResultadoReserva>;
  /** Chamada real à ULBRA (credencial de backend, somente leitura). */
  lerConversa(conversaId: string, antesDe: string | null, limite: number): Promise<unknown>;
  agora(): number;
}

export type ResultadoHistorico =
  | { ok: true; origem: "cache" | "ulbra"; pagina: PaginaMensagens; chamadas: number; saldoAte: string | null; saldoRestam?: number; saldoEm?: string; alcance: string }
  | { ok: false; motivo: MotivoBloqueio };

interface EntradaCache {
  expira: number;
  pagina: PaginaMensagens;
}

/** Cache por conversa+cursor, em memória de UMA instância. É só otimização: o limite vem do banco. */
const cache = new Map<string, EntradaCache>();
// Retenção: texto de conversa em memória só enquanto válido, e no máximo CACHE_MAX_ENTRADAS.
export const CACHE_MAX_ENTRADAS = 200;
export function guardarCache(chave: string, entrada: EntradaCache, agoraMs: number): void {
  for (const [k, v] of cache) if (v.expira <= agoraMs) cache.delete(k);
  cache.set(chave, entrada);
  while (cache.size > CACHE_MAX_ENTRADAS) cache.delete(cache.keys().next().value as string);
}
/** Pedidos idênticos em curso: um só faz a chamada e os demais esperam o mesmo resultado. */
const emCurso = new Map<string, Promise<ResultadoHistorico>>();

export function cacheTamanhoParaTeste(): number { return cache.size; }
export function limparCacheParaTeste(): void {
  bloqueioLocal = { ativo: false, ateMs: null, semPrazo: false, pendente: false };
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
  // Autorização ANTES do cache: quem perdeu a carteira ou a responsabilidade não lê nem do cache.
  const contextoAgora = await deps.consultarPermissao(operador, conversaId);
  if (!contextoAgora) return { ok: false, motivo: "SEM_PERMISSAO_NA_CONVERSA" };
  const autAgora = autorizarHistorico(contextoAgora);
  if (!autAgora.ok) return { ok: false, motivo: autAgora.motivo! };
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

  const fotografia = await deps.lerSaldo();
  const saldo = avaliarSaldo(fotografia, deps.agora());
  // Saldo vencido NÃO nega aqui: ele é renovado (com reserva) mais adiante.
  if (!fotografia) return { ok: false, motivo: "SALDO_SEM_INFORMACAO" };
  // Teto global do histórico = saldo medido menos a reserva. A reserva nunca é
  // gasta pelo histórico. O saldo é uma fotografia: a coleta também gasta.
  const tetoGlobal = Math.max(0, Math.min(fotografia!.restam - RESERVA_GLOBAL, TETO_HISTORICO_DIA));

  // Bloqueio após 429: nenhuma chamada e nenhuma reserva enquanto ele vigorar.
  // Se a gravação do último 429 FALHOU (pendente), tenta gravar de novo antes de qualquer decisão;
  // se não conseguir, fecha (fail-closed). Quando não há pendência, o BANCO decide: a liberação
  // feita pela gestão vale em todas as instâncias, inclusive nas que já estavam quentes.
  if (bloqueioLocal.pendente) {
    const restante = bloqueioLocal.ateMs === null ? null : Math.max(0, Math.ceil((bloqueioLocal.ateMs - deps.agora()) / 1000));
    try {
      await deps.registrarBloqueio(bloqueioLocal.ateMs === null ? null : restante);
      bloqueioLocal = { ativo: false, ateMs: null, semPrazo: false, pendente: false };
    } catch {
      return { ok: false, motivo: "ULBRA_BLOQUEADA" };
    }
  }
  const bloqueio = await deps.lerBloqueio();
  if (bloqueio.ativo && (bloqueio.semPrazo || (bloqueio.ateMs !== null && deps.agora() < bloqueio.ateMs))) {
    return { ok: false, motivo: "ULBRA_BLOQUEADA" };
  }

  // Orçamento ANTES de qualquer chamada externa. Saldo vencido: a renovação conta como 1 tentativa,
  // então reserva 2 (renovação + leitura). Tentativa que falha depois da reserva também conta.
  const quantidade = saldo.ok ? 1 : 2;
  const reserva = await deps.reservar(operador, quantidade, LIMITE_OPERADOR_DIA, tetoGlobal);
  if (!reserva.permitido) {
    const motivo: MotivoBloqueio = reserva.motivo
      ?? (reserva.usadasOperador + quantidade > LIMITE_OPERADOR_DIA ? "LIMITE_OPERADOR_DIA" : "RESERVA_GLOBAL");
    return { ok: false, motivo };
  }

  let saldoAtual = fotografia!;
  if (!saldo.ok) {
    let nova: FotografiaSaldo | null;
    try {
      nova = await deps.renovarSaldo();
    } catch (e) {
      return { ok: false, motivo: await motivoDe429(e, deps) };
    }
    if (!nova) return { ok: false, motivo: "SALDO_SEM_INFORMACAO" };
    const v = avaliarSaldo(nova, deps.agora());
    if (!v.ok) return { ok: false, motivo: v.motivo! };
    saldoAtual = nova;
  }

  let resposta: unknown;
  try {
    resposta = await deps.lerConversa(conversaId, antesDe, TAMANHO_PAGINA);
  } catch (e) {
    // A reserva já foi gasta: conta como chamada. Não repete automaticamente.
    return { ok: false, motivo: await motivoDe429(e, deps) };
  }
  const pagina = mapearPagina(resposta);
  guardarCache(chave, { expira: deps.agora() + CACHE_VALIDADE_MS, pagina }, deps.agora());
  return {
    ok: true, origem: "ulbra", pagina, chamadas: quantidade, saldoAte: avaliarSaldo(saldoAtual, deps.agora()).validadeAte ?? null,
    saldoRestam: saldoAtual.restam, saldoEm: saldoAtual.em, alcance: ALCANCE,
  };
}

// 429 vira bloqueio compartilhado. Retry-After (segundos) só quando a ULBRA informa; senão, sem prazo.
// Bloqueio na memória da instância: vale mesmo se a gravação no banco falhar.
let bloqueioLocal: { ativo: boolean; ateMs: number | null; semPrazo: boolean; pendente: boolean } = { ativo: false, ateMs: null, semPrazo: false, pendente: false };

async function motivoDe429(e: unknown, deps: DependenciasHistorico): Promise<MotivoBloqueio> {
  const msg = (e as Error).message;
  if (msg !== "ULBRA_LIMITE") return "ULBRA_INDISPONIVEL";
  const ra = (e as { retryAfterSegundos?: number | null }).retryAfterSegundos ?? null;
  const ateMs = ra === null ? null : deps.agora() + ra * 1000;
  try {
    await deps.registrarBloqueio(ra);
    bloqueioLocal = { ativo: false, ateMs: null, semPrazo: false, pendente: false };
  } catch (erroGravacao) {
    // Gravação falhou: a instância fica bloqueada (pendente) até gravar; a chamada sobe como erro.
    bloqueioLocal = { ativo: true, ateMs, semPrazo: ra === null, pendente: true };
    throw erroGravacao;
  }
  return "ULBRA_LIMITE";
}

export const TAMANHO = TAMANHO_PAGINA;

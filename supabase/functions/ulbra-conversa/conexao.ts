// ===========================================================================
// CONEXÃO INDIVIDUAL DO OPERADOR com a Mensageria ULBRA (OAuth por pessoa).
//
// Lógica pura. O provedor real (troca de código, renovação, revogação) entra
// por injeção: em teste, `ProvedorSimulado`. Nada aqui usa a credencial central
// `ULBRA_MCP_TOKEN` nem o cliente OAuth de outra aplicação (ex.: Claude).
//
// Regras:
//  - sem conexão ativa do PRÓPRIO operador, não há envio. Nunca há fallback.
//  - o token de acesso é renovado antes de vencer (margem de MARGEM_MS).
//  - refresh_token é rotacionado: o novo substitui o antigo a cada renovação.
//  - falha de renovação ou token revogado vira EXPIRADA/REVOGADA, e o envio é bloqueado.
// ===========================================================================

export const MARGEM_MS = 5 * 60 * 1000;

export type EstadoConexao =
  | "SEM_CONEXAO"
  | "ATIVA"
  | "EXPIRANDO"
  | "EXPIRADA"
  | "REVOGADA";

export interface RegistroConexao {
  operador_email: string;
  /** Opaco para esta lógica: a criptografia é responsabilidade da camada de armazenamento. */
  access_token: string;
  refresh_token: string | null;
  /** Instante (ms desde a época) em que o access_token vence. */
  expira_em_ms: number;
  revogada_em_ms: number | null;
}

export interface TokensOAuth {
  access_token: string;
  refresh_token: string | null;
  expira_em_ms: number;
}

/** Contrato do provedor OAuth da Mensageria. A implementação real depende da TI da ULBRA. */
export interface ProvedorOAuth {
  renovar(refreshToken: string): Promise<TokensOAuth>;
  revogar(token: string): Promise<void>;
}

export function estadoConexao(r: RegistroConexao | null, agoraMs: number): EstadoConexao {
  if (!r) return "SEM_CONEXAO";
  if (r.revogada_em_ms !== null) return "REVOGADA";
  if (agoraMs < r.expira_em_ms - MARGEM_MS) return "ATIVA";
  if (r.refresh_token) return "EXPIRANDO";
  return "EXPIRADA";
}

/** Só ATIVA ou EXPIRANDO (renovável) permitem uso. Qualquer outro estado bloqueia. */
export function conexaoUtilizavel(estado: EstadoConexao): boolean {
  return estado === "ATIVA" || estado === "EXPIRANDO";
}

export type ResultadoRenovacao =
  | { ok: true; registro: RegistroConexao }
  | { ok: false; estado: "EXPIRADA" | "REVOGADA"; motivo: string };

/** Renova quando está expirando. Se a renovação falhar, o estado vira EXPIRADA e o envio é bloqueado. */
export async function garantirConexao(
  r: RegistroConexao | null,
  provedor: ProvedorOAuth,
  agoraMs: number,
): Promise<ResultadoRenovacao> {
  const estado = estadoConexao(r, agoraMs);
  if (estado === "SEM_CONEXAO") return { ok: false, estado: "EXPIRADA", motivo: "SEM_CONEXAO" };
  if (estado === "REVOGADA") return { ok: false, estado: "REVOGADA", motivo: "REVOGADA" };
  if (estado === "EXPIRADA") return { ok: false, estado: "EXPIRADA", motivo: "SEM_REFRESH" };
  if (estado === "ATIVA") return { ok: true, registro: r! };
  // EXPIRANDO: renova com o refresh atual; o novo refresh substitui o antigo.
  try {
    const novo = await provedor.renovar(r!.refresh_token!);
    return {
      ok: true,
      registro: {
        ...r!,
        access_token: novo.access_token,
        refresh_token: novo.refresh_token ?? r!.refresh_token,
        expira_em_ms: novo.expira_em_ms,
      },
    };
  } catch (e) {
    const motivo = (e as Error).message;
    return { ok: false, estado: "EXPIRADA", motivo: `RENOVACAO_FALHOU: ${motivo}` };
  }
}

export interface ResultadoDesconexao {
  registro: RegistroConexao;
  /** Verdadeiro quando o provedor confirmou a revogação. Falso = revogada localmente, pendente no provedor. */
  revogada_no_provedor: boolean;
}

/**
 * Desconecta o operador. A conexão local é marcada como revogada SEMPRE, para
 * bloquear o envio mesmo que o provedor esteja fora do ar. Se a revogação no
 * provedor falhar, isso fica registrado para tratamento.
 */
export async function desconectar(
  r: RegistroConexao,
  provedor: ProvedorOAuth,
  agoraMs: number,
): Promise<ResultadoDesconexao> {
  let revogada = false;
  try {
    await provedor.revogar(r.refresh_token ?? r.access_token);
    revogada = true;
  } catch {
    revogada = false;
  }
  return {
    registro: { ...r, revogada_em_ms: agoraMs },
    revogada_no_provedor: revogada,
  };
}

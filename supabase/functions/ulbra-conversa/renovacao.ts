// ===========================================================================
// Gravação da RENOVAÇÃO com compare-and-set (CAS).
//
// Uma renovação em voo não pode reativar conexão desconectada nem sobrescrever
// uma conexão nova. A gravação só acontece se o estado lido antes da troca
// AINDA for o mesmo (mesmo refresh cifrado e não revogada). Caso contrário, nada
// é gravado e os tokens recém-emitidos são descartados (grant.ts).
// ===========================================================================

export interface EstadoLinha {
  refresh_cifrado: string | null;
  revogada: boolean;
}

export interface GuardaRenovacao {
  ler(): Promise<EstadoLinha | null>;
  /** Atualiza SÓ se a linha ainda estiver no estado `esperado`. true = gravou. */
  gravarSe(esperado: EstadoLinha, novo: { access_cifrado: string; refresh_cifrado: string | null; expira_em_ms: number }): Promise<boolean>;
}

export type ResultadoRenovacaoGravada = "GRAVADA" | "CONEXAO_MUDOU";

/** Lê, e só então grava com CAS. Qualquer mudança concorrente vira CONEXAO_MUDOU. */
export async function gravarRenovacaoSe(
  guarda: GuardaRenovacao,
  estadoAntes: EstadoLinha | null,
  novo: { access_cifrado: string; refresh_cifrado: string | null; expira_em_ms: number },
): Promise<ResultadoRenovacaoGravada> {
  if (!estadoAntes || estadoAntes.revogada) return "CONEXAO_MUDOU";
  const agora = await guarda.ler();
  if (!agora || agora.revogada) return "CONEXAO_MUDOU";
  if (agora.refresh_cifrado !== estadoAntes.refresh_cifrado) return "CONEXAO_MUDOU";
  const ok = await guarda.gravarSe(estadoAntes, novo);
  return ok ? "GRAVADA" : "CONEXAO_MUDOU";
}

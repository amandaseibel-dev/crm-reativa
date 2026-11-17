// ===========================================================================
// Grant OAuth recém-emitido que NÃO entra na conexão do operador.
//
// Contrato real (RFC 7009 via oauth.ts:revogarToken): a revogação é por TOKEN.
// Não há prova de cascata: revogar o refresh_token NÃO é tratado como revogar o
// access_token, e vice-versa. Por isso revogamos os DOIS, cada um por chamada.
//
// Se a revogação falha e não há como descartar com segurança, o grant é
// guardado em QUARENTENA (cifrado, marcado como revogado, pessoa desconhecida),
// para que desconectar depois possa tentar revogá-lo de novo. Quarentena só vale
// quando a identidade NÃO pôde ser conferida (nunca para divergência: aí o token
// pertence a outra conta e não deve ser guardado).
// ===========================================================================

export interface TokensGrant {
  access_token: string;
  refresh_token: string | null;
}

export interface DepsDescarte {
  /** Revoga um token no provedor. Lança em falha. */
  revogar(token: string): Promise<void>;
  /** Só quando permitido: guarda cifrado em quarentena. 'GRAVADA' ou 'EXISTENTE'. Lança em erro. */
  quarentena?: () => Promise<"GRAVADA" | "EXISTENTE">;
  /** Marca a quarentena como revogada localmente (bloqueia uso). Lança em erro. */
  marcarRevogada?: () => Promise<void>;
}

export type ResultadoDescarte =
  | { revogado: true; quarentena: false }
  | { revogado: false; quarentena: true }
  | { revogado: false; quarentena: false; pendente: true };

export async function descartarGrant(t: TokensGrant, deps: DepsDescarte): Promise<ResultadoDescarte> {
  let revogado = true;
  const tokens = [t.refresh_token, t.access_token].filter((x): x is string => typeof x === "string" && x.length > 0);
  for (const tk of tokens) {
    try { await deps.revogar(tk); } catch { revogado = false; }
  }
  if (revogado) return { revogado: true, quarentena: false };
  if (deps.quarentena && deps.marcarRevogada) {
    try {
      const g = await deps.quarentena();
      if (g === "GRAVADA") {
        try { await deps.marcarRevogada(); } catch { /* sem marcação, a quarentena ainda não é usada: pessoa nula bloqueia */ }
        return { revogado: false, quarentena: true };
      }
    } catch { /* não guardou: pendente */ }
  }
  return { revogado: false, quarentena: false, pendente: true };
}

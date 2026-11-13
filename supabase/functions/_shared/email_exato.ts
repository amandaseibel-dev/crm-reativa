// Identificação por e-mail SEM operadores de padrão. `ilike` trata `_`, `%` (e `*`, via
// PostgREST) como curingas. Aqui o e-mail é só normalizado (espaços e caixa) e comparado
// por igualdade exata (`.eq`). Identidade duplicada (mais de uma linha ativa) é negada.

export function emailNormalizado(valor: string | null | undefined): string {
  return String(valor ?? "").trim().toLowerCase();
}

/** Devolve a única linha ativa; null se nenhuma ou se houver mais de uma (identidade ambígua). */
export function unicoAtivo<T>(linhas: T[] | null | undefined): T | null {
  if (!Array.isArray(linhas) || linhas.length !== 1) return null;
  return linhas[0];
}

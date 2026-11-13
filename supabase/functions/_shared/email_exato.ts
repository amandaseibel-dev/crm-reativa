// Correspondência EXATA de e-mail para autorização. `ilike` sem escape trata `_` e `%`
// como curingas: "a_b@x" casaria "axb@x". Aqui o valor é escapado antes do ilike, e
// assim continua case-insensitive mas só casa o e-mail inteiro.
export function escaparLike(valor: string): string {
  return valor.replace(/[\\%_]/g, (c) => "\\" + c);
}

export function emailNormalizado(valor: string | null | undefined): string {
  return String(valor ?? "").trim().toLowerCase();
}

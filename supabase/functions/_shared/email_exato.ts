// Identificação de usuário por e-mail, sem operadores de padrão.
//
// REGRA (única, usada pelas cinco funções e pela verificação de duplicidade):
//  1. o pedido é normalizado: espaços nas pontas removidos e tudo em minúsculas;
//  2. a consulta usa `.eq` (igualdade exata). Nunca `.ilike`: `_`, `%` e `*` viram
//     curingas e `\` escapa, e qualquer um deles casaria outra conta;
//  3. só linhas ativas entram, e a consulta pede até 2 linhas: se vier 0, ou 2 ou
//     mais, a identidade é negada (fail-closed).
//
// LIMITAÇÃO CONHECIDA, sem solução na estrutura atual: `.eq` diferencia maiúscula.
//  - Um cadastro gravado com maiúscula (ex.: "Amanda@x") NÃO casa com o pedido
//    normalizado ("amanda@x") e a pessoa recebe negação (fail-closed).
//  - Duas linhas ativas que diferem só por caixa ("amanda@x" e "Amanda@x") NÃO são
//    detectadas como duplicidade: a consulta devolve só a minúscula e ela é aceita.
//  Em produção, em 13/11/2026, não há e-mail com maiúscula nem duplicidade ativa
//  (conferido por leitura). Corrigir a duplicidade por caixa exige `lower(email)` no
//  banco, ou seja, função SQL ou índice, que são outra autorização.

export function emailNormalizado(valor: string | null | undefined): string {
  return String(valor ?? "").trim().toLowerCase();
}

/** Devolve a única linha ativa; null se nenhuma ou se houver mais de uma (identidade ambígua). */
export function unicoAtivo<T>(linhas: T[] | null | undefined): T | null {
  if (!Array.isArray(linhas) || linhas.length !== 1) return null;
  return linhas[0];
}

/** Recorte mínimo do cliente Supabase usado aqui (permite teste com dublê). */
// deno-lint-ignore no-explicit-any
export type ClienteUsuarios = { from: (tabela: string) => any };

/**
 * Consulta a identidade pela regra acima. `colunas` é o select da tabela `usuarios`.
 * Toda função que identifica usuário por e-mail deve chamar ESTA função.
 */
export async function buscarUsuarioAtivoPorEmail<T = Record<string, unknown>>(
  sb: ClienteUsuarios,
  email: string | null | undefined,
  colunas: string,
): Promise<T | null> {
  const alvo = emailNormalizado(email);
  if (!alvo) return null;
  const { data } = await sb.from("usuarios")
    .select(colunas)
    .eq("email", alvo)
    .eq("ativo", true)
    .limit(2);
  return unicoAtivo<T>(data as T[] | null);
}

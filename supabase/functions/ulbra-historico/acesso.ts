// ===========================================================================
// Portão de acesso da função ulbra-historico: token do cabeçalho e usuário.
//
// Busca de usuário por e-mail é SEMPRE de correspondência exata (eq). ILIKE
// trata "_" e "%" como curingas: "cobranca_10@" casaria "cobranca10@", e um
// operador herdaria as permissões de outro. Os e-mails de public.usuarios
// estão em minúsculas (conferido em 13/11/2026); a comparação normaliza o
// pedido, não o banco.
// ===========================================================================

export interface UsuarioAtivo {
  email: string;
  perfil: string;
}

/** Recorte mínimo do cliente Supabase usado aqui (permite teste com dublê). */
// deno-lint-ignore no-explicit-any
export type ClienteUsuarios = { from: (tabela: string) => any };

export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Token do cabeçalho `Authorization: Bearer <token>`, ou null se ausente ou vazio. */
export function tokenDoHeader(cabecalho: string | null): string | null {
  if (!cabecalho || !cabecalho.startsWith("Bearer ")) return null;
  const token = cabecalho.slice("Bearer ".length).trim();
  return token ? token : null;
}

/** Usuário ativo com este e-mail exato, ou null. Nunca casa por padrão. */
export async function buscarUsuarioAtivo(sb: ClienteUsuarios, email: string): Promise<UsuarioAtivo | null> {
  const alvo = normalizarEmail(email);
  if (!alvo) return null;
  const { data } = await sb.from("usuarios")
    .select("email, perfil, ativo")
    .eq("email", alvo)
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { email: String(data.email), perfil: String(data.perfil) };
}

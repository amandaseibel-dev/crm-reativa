// Portão da ulbra-leads-pendentes, isolado do Deno para teste.
//
// Quem decide é o banco, pela identidade do JWT: `receptivo` vem da linha do
// próprio usuário em public.usuarios e `gestao` vem de usuario_e_gestao(), a
// mesma função que as políticas de RLS usam. Não existe coluna `gestao`.

export interface UsuarioLeads {
  receptivo: boolean;
  gestao: boolean;
}

export interface EntradaPortaoLeads {
  autorizacao: string;
  obterUsuario: (auth: string) => Promise<UsuarioLeads | null>;
}

export type DecisaoLeads =
  | { ok: true }
  | { ok: false; status: number; corpo: Record<string, unknown> };

export async function decidirAcessoLeads(e: EntradaPortaoLeads): Promise<DecisaoLeads> {
  if (!e.autorizacao.startsWith("Bearer ")) {
    return { ok: false, status: 401, corpo: { erro: "SEM_TOKEN" } };
  }
  const usuario = await e.obterUsuario(e.autorizacao).catch(() => null);
  if (!usuario) return { ok: false, status: 403, corpo: { erro: "ACESSO_NEGADO" } };
  if (usuario.receptivo || usuario.gestao) return { ok: true };
  return { ok: false, status: 200, corpo: { leads: [], motivo: "NAO_RECEPTIVO" } };
}

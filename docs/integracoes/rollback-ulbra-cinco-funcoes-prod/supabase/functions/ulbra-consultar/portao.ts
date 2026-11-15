// Portao de acesso da `ulbra-consultar`, isolado do Deno de proposito.
//
// `validarOperador` retorna o usuario autenticado (email + perfil) quando ele
// existe e esta ativo em public.usuarios. Retorna null em qualquer outro caso.
//
// `verificarEscopoAluno` decide se esse usuario tem acesso ao aluno_id pedido:
//   - perfis amplos (supervisor, gerencia, administrativo): sempre sim
//   - perfil 'operador': so se for o responsavel_atual_email do aluno
//
// Ambas as funcoes entram como dependencias injetadas para permitir teste
// unitario sem Deno.env, Deno.serve ou chamadas reais ao banco.

export type PerfilUsuario = {
  email: string;
  perfil: string;
};

export interface EntradaPortaoUlbra {
  autorizacao: string;
  validarOperador: (auth: string) => Promise<PerfilUsuario | null>;
  verificarEscopoAluno: (email: string, perfil: string, aluno_id: string) => Promise<boolean>;
  aluno_id: string;
}

export type DecisaoUlbra =
  | { ok: true; usuario: PerfilUsuario }
  | { ok: false; status: number; corpo: Record<string, unknown> };

export const PERFIS_AMPLOS = ["supervisor", "gerencia", "administrativo"];

export async function decidirAcessoUlbra(
  e: EntradaPortaoUlbra
): Promise<DecisaoUlbra> {
  if (!e.autorizacao.startsWith("Bearer ")) {
    return { ok: false, status: 401, corpo: { erro: "SEM_TOKEN" } };
  }

  const usuario = await e.validarOperador(e.autorizacao).catch(() => null);
  if (!usuario) {
    return {
      ok: false,
      status: 403,
      corpo: { erro: "ACESSO_NEGADO", detalhe: "operador nao encontrado" },
    };
  }

  // Perfis amplos (supervisor, gestao, administrativo) tem acesso a qualquer aluno
  if (PERFIS_AMPLOS.includes(usuario.perfil)) {
    return { ok: true, usuario };
  }

  // Operador comum: verificar se o aluno esta na sua carteira
  const temAcesso = await e.verificarEscopoAluno(
    usuario.email,
    usuario.perfil,
    e.aluno_id
  ).catch(() => false);

  if (!temAcesso) {
    return {
      ok: false,
      status: 403,
      corpo: { erro: "ACESSO_NEGADO", detalhe: "aluno_fora_da_carteira" },
    };
  }

  return { ok: true, usuario };
}

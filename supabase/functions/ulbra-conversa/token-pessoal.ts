// ===========================================================================
// CADASTRO DE TOKEN PESSOAL da Mensageria, por operador (piloto).
//
// Alternativa ao OAuth enquanto o client_id do ReATIVA não existe na Mensageria.
// Lógica pura: o handler (index.ts) injeta a consulta meu_acesso e a gravação
// cifrada. Nada aqui devolve o valor do token.
//
// Regras, nesta ordem (qualquer falha não grava nada):
//  1. formato do token e validade escolhida (7, 30, 60 ou 90 dias);
//  2. meu_acesso com o PRÓPRIO token: a pessoa dona do token precisa ser o
//     usuário autenticado no CRM (e-mail exato, sem confiar no nome);
//  3. só então grava: cifrado, sem refresh token, com validade fixa.
//
// Expiração: sem refresh_token, estadoConexao (conexao.ts) vira EXPIRADA ao
// vencer e o envio/leitura são bloqueados. Renovação é nova criação na Mensageria.
// ===========================================================================

export const VALIDADES_DIAS = [7, 30, 60, 90] as const;
export type ValidadeDias = (typeof VALIDADES_DIAS)[number];

/** Escopos do piloto: leitura da ficha + resposta. Hipótese até o teste real (ver pacote). */
export const ESCOPOS_PILOTO = [
  "ver clientes",
  "ver atendimentos",
  "ler as conversas com os clientes",
  "enviar mensagens e templates aos clientes dos seus atendimentos",
] as const;

export interface IdentidadeToken {
  pessoa_email: string | null;
  pessoa_nome: string | null;
  escopos: unknown;
  so_leitura: boolean | null;
}

export interface DepsTokenPessoal {
  /** E-mail do usuário autenticado no CRM (JWT), minúsculo. */
  email: string;
  /** Chamada meu_acesso com o próprio token. Lança erro quando a Mensageria recusa. */
  identidadeDoToken(token: string): Promise<IdentidadeToken>;
  /** Grava cifrado. Nunca recebe nem devolve o token em claro para fora do backend. */
  guardar(dados: { access_token: string; expira_em_ms: number }, extra: Record<string, unknown>): Promise<void>;
  agoraMs: number;
}

export type MotivoTokenPessoal =
  | "TOKEN_FORMATO_INVALIDO"
  | "VALIDADE_NAO_PERMITIDA"
  | "TOKEN_RECUSADO_PELA_MENSAGERIA"
  | "MENSAGERIA_INDISPONIVEL"
  | "IDENTIDADE_DIVERGENTE";

export type ResultadoTokenPessoal =
  | { ok: true; pessoa: string | null; expira_em: string; estado: "ATIVA" }
  | { ok: false; motivo: MotivoTokenPessoal };

export async function cadastrarTokenPessoal(
  deps: DepsTokenPessoal,
  token: string,
  validadeDias: number,
): Promise<ResultadoTokenPessoal> {
  const t = token.trim();
  if (t.length < 20 || t.length > 4096 || /\s/.test(t)) return { ok: false, motivo: "TOKEN_FORMATO_INVALIDO" };
  if (!(VALIDADES_DIAS as readonly number[]).includes(validadeDias)) return { ok: false, motivo: "VALIDADE_NAO_PERMITIDA" };

  let identidade: IdentidadeToken;
  try {
    identidade = await deps.identidadeDoToken(t);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg === "ULBRA_AUTENTICACAO") return { ok: false, motivo: "TOKEN_RECUSADO_PELA_MENSAGERIA" };
    return { ok: false, motivo: "MENSAGERIA_INDISPONIVEL" };
  }

  // A2: o token precisa pertencer a quem está logado no CRM. Divergência: não grava.
  if ((identidade.pessoa_email ?? "").trim().toLowerCase() !== deps.email) {
    return { ok: false, motivo: "IDENTIDADE_DIVERGENTE" };
  }

  const expiraEmMs = deps.agoraMs + validadeDias * 24 * 60 * 60 * 1000;
  await deps.guardar(
    { access_token: t, expira_em_ms: expiraEmMs },
    {
      conectada_em: new Date(deps.agoraMs).toISOString(),
      pessoa_nome: identidade.pessoa_nome,
      pessoa_email: identidade.pessoa_email,
      escopos: identidade.escopos ?? null,
      so_leitura: identidade.so_leitura,
    },
  );
  return {
    ok: true,
    pessoa: identidade.pessoa_nome,
    expira_em: new Date(expiraEmMs).toISOString(),
    estado: "ATIVA",
  };
}

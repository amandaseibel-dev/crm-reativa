// ===========================================================================
// Leitura do histórico (ação historico_ler) e capacidade (historico_capacidade).
// Função PURA sobre dependências injetadas: o handler de index.ts monta as
// dependências com o cliente do banco e o transporte MCP; os testes (vitest)
// executam este mesmo caminho com dependências simuladas.
//
// Ordem (cada etapa só roda se a anterior passou):
//  1. flag do backend (ULBRA_HISTORICO_HABILITADO) — caller;
//  2. usuário ativo (checado no handler de entrada);
//  3. conversa existe e tem cliente;
//  4. identidade do aluno (vínculo alta_cpf) e permissão (dono/responsável; leitura
//     global só pela regra temLeituraGlobal);
//  5. conexão individual do operador, com identidade do JWT (divergência bloqueia);
//  6. leitura pela conexão individual; auditoria OBRIGATÓRIA antes de devolver texto.
// ===========================================================================
import { mapearPagina, permitirLeitura, temLeituraGlobal, type ContextoLeitura, type PaginaMensagens } from "./leitura.ts";

export interface DepsHistorico {
  email: string;
  usuarioAtivo: boolean;
  flagLigada: boolean;
  conversaId: string;
  antesDe: string | null;
  buscarClienteDaConversa(conversaId: string): Promise<string | null>;
  alunoDoCliente(clienteId: string): Promise<string | null>;
  donosDoAluno(alunoId: string): Promise<string[]>;
  responsaveisDoCliente(clienteId: string): Promise<string[]>;
  conexao(): Promise<
    | { ok: true; access_token: string; pessoa_email?: string | null }
    | { ok: false; motivo: string }
  >;
  lerConversa(accessToken: string, args: Record<string, unknown>): Promise<{ erro?: boolean | string | null; dados?: unknown }>;
  auditar(detalhes: Record<string, unknown>): Promise<boolean>;
}

export interface Saida {
  status: number;
  corpo: Record<string, unknown>;
}

const ACAO_LEITURA = "ULBRA_HISTORICO_LEITURA";

/** Contexto de permissão calculado no servidor, a partir de dados do banco agora. */
async function montarContexto(d: DepsHistorico, clienteId: string): Promise<ContextoLeitura> {
  const operador = d.email;
  const alunoId = await d.alunoDoCliente(clienteId);
  if (!alunoId) return { operador, identidade_confirmada: false, dono_carteira: null, responsavel_atendimento: null };
  const donos = [...new Set((await d.donosDoAluno(alunoId)).map((e) => e.toLowerCase()))];
  const resps = [...new Set((await d.responsaveisDoCliente(clienteId)).map((e) => e.toLowerCase()))];
  const globalOk = temLeituraGlobal(operador, { ativo: d.usuarioAtivo });
  return {
    operador,
    identidade_confirmada: true,
    dono_carteira: globalOk ? operador : (donos.length === 1 ? donos[0] : null),
    responsavel_atendimento: resps.length === 1 ? resps[0] : null,
  };
}

/** Capacidade de ler o histórico desta conversa, calculada pelo servidor. Não lê a Mensageria. */
export async function capacidadeHistorico(d: DepsHistorico): Promise<{ pode: boolean; motivo: string | null }> {
  if (!d.flagLigada) return { pode: false, motivo: "HISTORICO_DESLIGADO" };
  if (!d.usuarioAtivo) return { pode: false, motivo: "ACESSO_NEGADO" };
  if (!/^[a-f0-9]{24}$/.test(d.conversaId)) return { pode: false, motivo: "CONVERSA_INVALIDA" };
  const clienteId = await d.buscarClienteDaConversa(d.conversaId);
  if (!clienteId) return { pode: false, motivo: "SEM_PERMISSAO_NA_CONVERSA" };
  const p = permitirLeitura(await montarContexto(d, clienteId));
  return p.ok ? { pode: true, motivo: null } : { pode: false, motivo: p.motivo };
}

/** Leitura de uma página do histórico. Devolve status HTTP e corpo; nunca texto sem auditoria. */
export async function lerHistoricoAutorizado(d: DepsHistorico): Promise<Saida> {
  if (!d.flagLigada) return { status: 403, corpo: { ok: false, motivo: "HISTORICO_DESLIGADO" } };
  if (!d.usuarioAtivo) return { status: 403, corpo: { ok: false, motivo: "ACESSO_NEGADO" } };
  if (!/^[a-f0-9]{24}$/.test(d.conversaId)) return { status: 400, corpo: { ok: false, motivo: "CONVERSA_INVALIDA" } };
  const clienteId = await d.buscarClienteDaConversa(d.conversaId);
  if (!clienteId) return { status: 403, corpo: { ok: false, motivo: "SEM_PERMISSAO_NA_CONVERSA" } };
  const p = permitirLeitura(await montarContexto(d, clienteId));
  if (!p.ok) return { status: 403, corpo: { ok: false, motivo: p.motivo } };

  const conn = await d.conexao();
  if (!conn.ok) return { status: 403, corpo: { ok: false, motivo: conn.motivo } };
  if ((conn.pessoa_email ?? "").toLowerCase() !== d.email) return { status: 403, corpo: { ok: false, motivo: "IDENTIDADE_DIVERGENTE" } };

  const args: Record<string, unknown> = d.antesDe
    ? { id: d.conversaId, limite: 20, antesDe: d.antesDe }
    : { id: d.conversaId, limite: 20 };
  let resultado: { erro?: boolean | string | null; dados?: unknown };
  try {
    resultado = await d.lerConversa(conn.access_token, args);
  } catch {
    return { status: 502, corpo: { ok: false, motivo: "ULBRA_INDISPONIVEL" } };
  }
  if (resultado.erro) return { status: 502, corpo: { ok: false, motivo: "ULBRA_INDISPONIVEL" } };
  const pagina: PaginaMensagens = mapearPagina(resultado.dados);

  // Auditoria ANTES de devolver o texto. Sem registro gravado, o texto não sai.
  const auditoriaOk = await d.auditar({ acao: ACAO_LEITURA, conversa_id: d.conversaId, mensagens: pagina.mensagens.length });
  if (!auditoriaOk) return { status: 500, corpo: { ok: false, motivo: "AUDITORIA_NAO_GRAVADA" } };
  return { status: 200, corpo: { ok: true, pagina } };
}

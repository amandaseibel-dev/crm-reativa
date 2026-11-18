// Ação historico_ler / historico_capacidade, com as dependências injetadas.
// O handler (index.ts) monta os adaptadores reais (banco, conexão individual, Mensageria, auditoria).
// Esta função decide: flag do backend, piloto, capacidade, leitura e auditoria. Não chama nada que não
// esteja nos adaptadores. Não existe credencial central aqui: a leitura usa só `conexao().access_token`.
import { capacidadeHistorico, lerHistoricoAutorizado, type DepsHistorico } from "./historico-leitura.ts";
import { pilotoPermiteLeitura } from "./piloto-leitura.ts";

export interface AdaptadoresHistorico {
  email: string;
  usuarioAtivo: boolean;
  /** ULBRA_HISTORICO_HABILITADO === "true" */
  habilitadoEnv: boolean;
  /** ULBRA_HISTORICO_PILOTO_EMAILS (lista do piloto, fail-closed) */
  listaPilotoEnv: string | null | undefined;
  buscarClienteDaConversa: DepsHistorico["buscarClienteDaConversa"];
  alunoDoCliente: DepsHistorico["alunoDoCliente"];
  donosDoAluno: DepsHistorico["donosDoAluno"];
  responsaveisDoCliente: DepsHistorico["responsaveisDoCliente"];
  conexao: DepsHistorico["conexao"];
  lerConversa: DepsHistorico["lerConversa"];
  auditar: DepsHistorico["auditar"];
  reservarCota: DepsHistorico["reservarCota"];
}

export async function executarAcaoHistorico(
  acao: string,
  corpo: Record<string, unknown>,
  a: AdaptadoresHistorico,
): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const conversaId = typeof corpo.conversa_id === "string" ? corpo.conversa_id : "";
  const antesDe = typeof corpo.antes_de === "string" && corpo.antes_de ? corpo.antes_de : null;
  const deps: DepsHistorico = {
    email: a.email,
    usuarioAtivo: a.usuarioAtivo,
    // Piloto: além da flag, só quem está em ULBRA_HISTORICO_PILOTO_EMAILS (fail-closed se vazia).
    flagLigada: a.habilitadoEnv && pilotoPermiteLeitura(a.email, a.listaPilotoEnv),
    conversaId,
    antesDe,
    buscarClienteDaConversa: a.buscarClienteDaConversa,
    alunoDoCliente: a.alunoDoCliente,
    donosDoAluno: a.donosDoAluno,
    responsaveisDoCliente: a.responsaveisDoCliente,
    conexao: a.conexao,
    lerConversa: a.lerConversa,
    auditar: a.auditar,
    reservarCota: a.reservarCota,
  };
  if (acao === "historico_capacidade") {
    const c = await capacidadeHistorico(deps);
    return { status: 200, corpo: { ok: true, ...c } };
  }
  return lerHistoricoAutorizado(deps);
}

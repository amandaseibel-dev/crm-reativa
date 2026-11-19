// ===========================================================================
// Autorização de RESPONDER uma conversa específica (decisão pura, sem rede).
//
// Usada em três pontos, com a mesma regra: envio_capacidade (a tela), envio_previa e envio_confirmar
// (revalidação no envio). `envioReal=true` sozinho não basta: a resposta é do RESPONSÁVEL comprovado
// pelo atendimento (ulbra_atendimentos.responsavel_email), com conexão individual ativa e a mesma
// identidade do usuário autenticado.
//
// Ordem dos bloqueios (o primeiro que se aplica é o motivo):
//   ENVIO_DESATIVADO > SEM_CONEXAO > IDENTIDADE_DIVERGENTE > CONVERSA_NAO_ESPELHADA
//   > SEM_ATENDIMENTO_ATIVO > ATENDIMENTO_NAO_RESPONSAVEL
// ===========================================================================

export type MotivoResposta =
  | "ENVIO_DESATIVADO"
  | "SEM_CONEXAO"
  | "IDENTIDADE_DIVERGENTE"
  | "CONVERSA_NAO_ESPELHADA"
  | "SEM_ATENDIMENTO_ATIVO"
  | "ATENDIMENTO_NAO_RESPONSAVEL";

export interface EntradaResposta {
  /** ULBRA_ENVIO_REAL e ULBRA_CONTRATO_PREVIA_CONFIRMADO, ambos ligados (habilitação geral). */
  envioReal: boolean;
  /** Conexão individual do operador ativa (garantirConexao ok). */
  conexaoOk: boolean;
  /** E-mail da conta conectada na Mensageria (meu_acesso). */
  pessoaConexao: string | null;
  /** Usuário autenticado no CRM. */
  email: string;
  /** A conversa existe no espelho (ulbra_conversas). */
  espelhada: boolean;
  /** Atendimento ativo (não dispensado) da conversa, se houver. */
  atendimentoAtivoId: string | null;
  /** Responsável comprovado desse atendimento (ulbra_atendimentos.responsavel_email). */
  responsavelAtivo: string | null;
}

export interface DecisaoResposta {
  pode: boolean;
  motivo: MotivoResposta | null;
}

const minusculo = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function decidirResposta(e: EntradaResposta): DecisaoResposta {
  const negar = (motivo: MotivoResposta): DecisaoResposta => ({ pode: false, motivo });
  if (!e.envioReal) return negar("ENVIO_DESATIVADO");
  if (!e.conexaoOk) return negar("SEM_CONEXAO");
  if (minusculo(e.pessoaConexao) !== minusculo(e.email)) return negar("IDENTIDADE_DIVERGENTE");
  if (!e.espelhada) return negar("CONVERSA_NAO_ESPELHADA");
  if (!e.atendimentoAtivoId) return negar("SEM_ATENDIMENTO_ATIVO");
  if (!e.responsavelAtivo || minusculo(e.responsavelAtivo) !== minusculo(e.email)) return negar("ATENDIMENTO_NAO_RESPONSAVEL");
  return { pode: true, motivo: null };
}

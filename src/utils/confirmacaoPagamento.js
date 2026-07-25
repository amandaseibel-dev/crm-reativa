// Regras de decisão da confirmação de pagamento (Fila de Confirmação).
//
// Contexto do fluxo (não alterar):
//   - o operador apenas anexa o comprovante e envia para confirmação;
//   - não se pede a ele valor, data, título, parcela ou acordo;
//   - Amanda/Fernanda confirmam apenas que o pagamento foi RECEBIDO.
//
// Confirmar recebimento != quitar aluno/caso. A quitação (e a reposição
// automática que ela dispara) só pode acontecer quando a RPC de validação
// de saldo (`confirmar_baixa_caso`) devolver explicitamente quitou = true.
//
// Esta função é pura de propósito: concentra a decisão para poder ser
// testada sem banco nem rede.

// Status de solicitação (fonte única — evita strings soltas espalhadas).
export const STATUS_AGUARDANDO_CONFIRMACAO = "AGUARDANDO_CONFIRMACAO";
// Pagamento recebido pela ADM, mas SEM identificação da dívida paga.
// Fica numa fila de revisão manual até Amanda/Fernanda vincularem.
export const STATUS_AGUARDANDO_VINCULO = "PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO";

// Solicitações AINDA ABERTAS (não finalizadas). Usado por filas, contadores e
// guards de deduplicação para NÃO tratar o novo status como concluído.
export const STATUS_CONFIRMACAO_ABERTOS = [
  STATUS_AGUARDANDO_CONFIRMACAO,
  STATUS_AGUARDANDO_VINCULO,
];

// true quando a solicitação ainda está aberta (pendente de ação da ADM).
export function isConfirmacaoAberta(status) {
  return STATUS_CONFIRMACAO_ABERTOS.includes(status);
}

/**
 * Decide o que fazer após a RPC de validação de saldo.
 *
 * @param {{quitou?: boolean, motivo?: string, detalhe?: any}|null} resBaixa
 *        Retorno de `confirmar_baixa_caso` (jsonb). null quando não houve chamada.
 * @param {any} erroBaixaCaso  Erro devolvido pela RPC (ou null/undefined).
 * @returns {{
 *   registrarRecebimento: boolean, // sempre: marca a solicitação como PAGAMENTO_CONFIRMADO
 *   quitarAluno: boolean,          // só quando quitou === true
 *   permitirReposicao: boolean,    // reposição só quando quitou === true
 *   manterNaCarteira: boolean,     // quitou !== true => mantém caso/fila/responsável
 *   saldoPendente: boolean         // quitou !== true (recebido, mas ainda deve)
 * }}
 */
export function planejarAcoesConfirmacao(resBaixa, erroBaixaCaso) {
  // Só quita com um "true" explícito da RPC. Qualquer erro, ausência de
  // retorno, quitou=false, quitou ausente ou valor não-booleano => NÃO quita.
  const quitou = !erroBaixaCaso && resBaixa != null && resBaixa.quitou === true;

  return {
    registrarRecebimento: true,
    quitarAluno: quitou,
    permitirReposicao: quitou,
    manterNaCarteira: !quitou,
    saldoPendente: !quitou,
  };
}

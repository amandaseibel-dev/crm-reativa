// Situações de título que o borderô NUNCA reabre no upsert por documento:
//   PAGO            -- dívida concluída;
//   EM_CONFIRMACAO  -- aguardando a Conferência Prime (o banco também recusa);
//   CANCELADA       -- saída administrativa (saiu da base / encerramento pela
//                      Conferência Prime): terminal, não volta a ser cobrada.
export const SITUACOES_QUE_NAO_REABREM = Object.freeze(["PAGO", "EM_CONFIRMACAO", "CANCELADA"]);

export function naoReabreNoBordero(situacaoAtual) {
  return SITUACOES_QUE_NAO_REABREM.includes(String(situacaoAtual || "").toUpperCase());
}

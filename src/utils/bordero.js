// Situações de título que o borderô NUNCA reabre no upsert por documento:
//   PAGO            -- dívida concluída;
//   EM_CONFIRMACAO  -- aguardando a Conferência Prime (o banco também recusa);
//   CANCELADA       -- saída administrativa (saiu da base / encerramento pela
//                      Conferência Prime): terminal, não volta a ser cobrada.
// + DEVOLVIDO (09/10/2026): a tabulação de desfecho tirou a mensalidade da
// cobrança sem recuperação da ReATIVA. O banco já recusa a reabertura
// (`trg_titulo_devolvido_terminal`), mas sem este nome aqui o importador
// contaria o título como "atualizado" enquanto o gatilho o restaurava em
// silêncio -- a tela afirmaria uma coisa e o banco teria feito outra.
export const SITUACOES_QUE_NAO_REABREM = Object.freeze([
  "PAGO",
  "EM_CONFIRMACAO",
  "CANCELADA",
  "DEVOLVIDO",
]);

export function naoReabreNoBordero(situacaoAtual) {
  return SITUACOES_QUE_NAO_REABREM.includes(String(situacaoAtual || "").toUpperCase());
}

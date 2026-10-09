// Situações de título que o borderô NUNCA reabre.
//
// 08/10/2026 — a lista foi ampliada por pedido da gestão ("impedir reativação de
// parcelas negociadas, pagas, quitadas, suspensas, canceladas, devolvidas ou
// encerradas"). Antes tinha só as três primeiras, e **NEGOCIADO ficava de fora**:
// o `upsert` do borderô grava `situacao: 'ABERTO'` fixo, então toda mensalidade
// negociada que voltasse no arquivo era reaberta — e nenhum dos três gatilhos de
// banco cobre NEGOCIADO (ver docs/SIMULACAO-REIMPORTACAO-PARCELAS-AUSENTES-2026-10-08.md §3).
//
//   PAGO            -- dívida concluída;
//   EM_CONFIRMACAO  -- aguardando a Conferência Prime (o banco também recusa);
//   CANCELADA       -- saída administrativa (saiu da base / encerramento pela
//                      Conferência Prime): terminal, não volta a ser cobrada;
//   NEGOCIADO       -- a dívida virou acordo. Reabrir desfaz a negociação e
//                      arrisca cobrar em dobro (o acordo já tem as parcelas);
//   QUITADO/QUITADA -- liquidada;
//   CANCELADO       -- grafia masculina presente na base;
//   DEVOLVIDA/DEVOLVIDO -- a tabulação de desfecho tirou a mensalidade da
//                      cobrança sem recuperação da ReATIVA. O desfecho é
//                      administrativo e pertence ao financeiro, não ao
//                      importador. O banco já recusa a reabertura
//                      (`trg_titulo_devolvido_terminal`, #662), mas sem o nome
//                      aqui o importador contaria o título como "atualizado"
//                      enquanto o gatilho o restaurava em silêncio -- a tela
//                      afirmaria uma coisa e o banco teria feito outra.
//
// "Suspensa" NÃO é situação de título: vive em `alunos.status_*`
// (SUSPENSAO_COBRANCA / JURIDICO / CANCELAMENTO_COBRANCA). A proteção desse caso
// é por aluno, na RPC `mensalidades_ausentes_inserir`, não aqui.
export const SITUACOES_QUE_NAO_REABREM = Object.freeze([
  "PAGO",
  "EM_CONFIRMACAO",
  "CANCELADA",
  "CANCELADO",
  "NEGOCIADO",
  "QUITADO",
  "QUITADA",
  "DEVOLVIDA",
  "DEVOLVIDO",
]);

export function naoReabreNoBordero(situacaoAtual) {
  return SITUACOES_QUE_NAO_REABREM.includes(String(situacaoAtual || "").toUpperCase());
}

// Status (coluna `status`, minúscula) que também são terminais. A situação e o
// status divergem na base — há título `VENCIDA`/`quitada` —, então conferir só
// `situacao` deixa passar linha já liquidada.
export const STATUS_QUE_NAO_REABREM = Object.freeze([
  "quitada",
  "cancelada",
  "devolvida",
]);

export function statusNaoReabreNoBordero(statusAtual) {
  return STATUS_QUE_NAO_REABREM.includes(String(statusAtual || "").toLowerCase());
}

// Decisão única usada pelo importador: este título existente pode ser tocado?
// Resposta sempre NÃO a partir de 08/10/2026 — o borderô passou a ser
// insert-only. Esta função existe para que o motivo do "ignorado" apareça na
// tela e no teste, não para liberar escrita.
export function motivoDeNaoTocar({ jaExiste, situacaoAtual, statusAtual }) {
  if (!jaExiste) return null;
  if (naoReabreNoBordero(situacaoAtual)) return `situação ${String(situacaoAtual).toUpperCase()}`;
  if (statusNaoReabreNoBordero(statusAtual)) return `status ${String(statusAtual).toLowerCase()}`;
  return "título já existe (a importação não atualiza existente)";
}

// Rótulos legíveis para os status de jornada/tabulação.
//
// POR QUE EXISTE: a ficha mostrava `EM_ABERTO`, `TERMO_RECEBIDO_LIBERADO`,
// `LINK_PRONTO_PARA_ENVIO` -- nome de coluna do banco na cara do operador.
//
// CUIDADO COM `BAIXA_REALIZADA`. O rótulo natural dele é "Pago", mas "Pago"
// só pode aparecer com saldo ZERADO: baixa de uma parcela num acordo que
// segue em aberto NÃO é quitação. Por isso este módulo devolve o rótulo
// neutro "Baixa realizada", e quem tiver o saldo em mãos decide se pode
// chamar de "Pago" -- ver `rotuloStatusComSaldo`.
export const MAPA_SITUACAO = {
  CONTATAR: "A contatar",
  MENSAGEM_ENVIADA: "Mensagem enviada",
  EM_ATENDIMENTO: "Em atendimento",
  ALUNO_EM_NEGOCIACAO_24H: "Em negociação",
  RETORNAR_DEPOIS: "Retornar depois",
  SEM_RETORNO: "Sem retorno",
  NAO_LOCALIZADO: "Não localizado",
  AGUARDANDO_LINK: "Aguardando link",
  SOLICITADO_LINK: "Link solicitado",
  LINK_PRONTO_PARA_ENVIO: "Link pronto p/ envio",
  LINK_ENVIADO_AO_ALUNO: "Link enviado",
  AGUARDANDO_COMPROVANTE: "Aguardando comprovante",
  AGUARDANDO_BAIXA: "Aguardando baixa",
  BAIXA_REALIZADA: "Baixa realizada",
  BAIXA_DEVOLVIDA: "Baixa devolvida",
  ACORDO_FECHADO: "Acordo fechado",
  LEMBRETE_PARCELA: "Lembrete de parcela feito",
  TERMO_ENVIADO_ALUNO: "Termo enviado",
  TERMO_ENVIADO_ADM: "Termo no ADM",
  TERMO_RECEBIDO_LIBERADO: "Termo liberado",
  TERMO_REJEITADO: "Termo rejeitado",
  EM_ABERTO: "Em cobrança",
  EM_NEGOCIACAO: "Em negociação",
  SEM_SALDO_EM_ABERTO: "Sem saldo em aberto",
  JURIDICO: "Jurídico",
  CANCELAMENTO_COBRANCA: "Cancelado",
  SUSPENSAO_COBRANCA: "Suspenso",
  QUITADO_MANUAL: "Quitado",
  ELOGIO_ATENDIMENTO: "Elogio de atendimento",
};

// Status desconhecido volta legível: SEM_RETORNO_HOJE -> "Sem retorno hoje".
export function rotuloStatus(status) {
  const s = String(status ?? "").trim();
  if (!s) return "";
  if (MAPA_SITUACAO[s]) return MAPA_SITUACAO[s];
  if (!/^[A-Z0-9_]+$/.test(s)) return s; // já é texto humano
  const t = s.replace(/_/g, " ").toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Só chame de "Pago" quem está com saldo comprovadamente zerado.
// `semSaldo` deve ser null/undefined quando o saldo não pôde ser lido --
// na dúvida NÃO afirmamos quitação.
export function rotuloStatusComSaldo(status, semSaldo) {
  if (status === "BAIXA_REALIZADA") {
    return semSaldo === true ? "Pago" : "Baixa realizada";
  }
  return rotuloStatus(status);
}

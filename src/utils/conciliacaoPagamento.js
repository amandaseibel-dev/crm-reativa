// Vocabulario unico da conciliacao de pagamento, para a tela e para os testes.
//
// O estado vem de `pagamentos.status_conciliacao`, gravado na propria insercao
// (migration 20260914140000). Ele responde "a parcela baixou, e se nao baixou,
// o que falta" -- pergunta diferente de `origem_vinculo`, que responde "de quem
// e o dinheiro". Uma linha pode ter aluno identificado e mesmo assim estar
// pendente: e exatamente o caso que era invisivel ate 14/09/2026.
//
// Nao existe estado "ja importado": a linha repetida e barrada ANTES do INSERT
// pela deduplicacao do importador e nunca chega a virar pagamento.

export const STATUS_CONCILIACAO = {
  BAIXADO: {
    rotulo: "Baixado",
    explica: "a parcela do boleto foi baixada nesta importação",
  },
  AGUARDANDO_ACORDO: {
    rotulo: "Aguardando acordo",
    explica: "o boleto é válido, mas o acordo ainda não existe no CRM",
  },
  AGUARDANDO_AMARRACAO: {
    rotulo: "Aguardando amarração",
    explica: "o acordo existe e tem parcela sem boleto: falta amarrar o boleto à parcela certa",
  },
  PARCELA_JA_PAGA: {
    rotulo: "Parcela já paga",
    explica: "a parcela do boleto já estava PAGO antes deste pagamento entrar",
  },
  REVISAO: {
    rotulo: "Revisão",
    explica: "divergência de vencimento, de valor ou acordo fora de ATIVO",
  },
  SEM_VINCULO: {
    rotulo: "Sem vínculo",
    explica: "a linha não trouxe boleto utilizável",
  },
};

// Linha anterior a 14/09/2026 nao tem estado, e a tela diz isso em vez de
// inventar um. Mesma decisao que foi tomada para origem_vinculo.
export const SEM_ESTADO = {
  rotulo: "Anterior à regra",
  explica: "entrou antes da conciliação registrar o desfecho (14/09/2026)",
};

export function estadoDaLinha(item) {
  const chave = item && item.status_conciliacao;
  return STATUS_CONCILIACAO[chave] || SEM_ESTADO;
}

// Vincular aluno so faz sentido quando o aluno AINDA e desconhecido.
// Quando o pagamento ja tem aluno -- resolvido por boleto exato ou por numero
// Ulbra unico -- a pendencia nao e de vinculo: e de amarracao, de acordo ou de
// revisao, e nenhuma delas se resolve trocando o aluno. Oferecer "Vincular"
// nessas linhas so daria a chance de sobrescrever um vinculo correto.
export function podeVincularAluno(item) {
  return !(item && item.tem_aluno);
}

// O dinheiro nao depende de nada disso: a projecao le `pagamentos` e ignora
// baixa, parcela e acordo. Serve para a tela dizer isso em voz alta, para
// ninguem tentar "consertar" a projecao pela fila.
export const AVISO_PROJECAO =
  "O valor já está na projeção do dia, baixando parcela ou não. Esta fila é de conciliação, não de dinheiro.";

export function contarPorStatus(linhas) {
  const conta = {};
  for (const l of linhas || []) {
    const chave = (l && l.status_conciliacao) || "SEM_ESTADO";
    conta[chave] = (conta[chave] || 0) + 1;
  }
  return conta;
}

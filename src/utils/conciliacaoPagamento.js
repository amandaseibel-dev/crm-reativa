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

// A ACAO CORRESPONDE AO PONTO EXATO EM QUE O PAGAMENTO TRAVOU (16/09/2026).
//
// "Aguardando acordo" sozinho nao diz o que fazer: o aluno pode estar provado
// por matricula + nome e o que falta e o acordo -- ou pode faltar o proprio
// aluno. Oferecer "Vincular aluno" a quem ja esta identificado so da a chance
// de trocar um vinculo certo. A trava vem de `pagamentos_trava` (banco), e cada
// uma tem no maximo UMA acao.
export const ACOES_DA_FILA = {
  REGISTRAR_ACORDO_AVISTA: "Registrar acordo à vista",
  VINCULAR_ALUNO: "Vincular aluno",
};

export const TRAVAS_AGUARDANDO_ACORDO = {
  ACORDO_AVISTA_AUSENTE: {
    rotulo: "Aluno identificado · acordo não encontrado",
    explica: "matrícula e nome apontam para o mesmo aluno; o acordo à vista deste boleto não existe no CRM",
    acao: "REGISTRAR_ACORDO_AVISTA",
  },
  // O 71752 de 16/09: um acordo de numero maior ja tinha vindo antes do dia do
  // pagamento. Fica fora do fluxo normal, e nesta versao nao ha liberacao manual.
  ACORDO_AVISTA_AUSENCIA_NAO_EXPLICADA: {
    rotulo: "Aluno identificado · ausência do acordo não explicada",
    explica: "um acordo de número maior já veio antes do dia do pagamento: este acordo existia e não apareceu no relatório. Fora do fluxo normal",
    acao: null,
  },
  ACORDO_PARCELADO_AUSENTE: {
    rotulo: "Aluno identificado · acordo parcelado não encontrado",
    explica: "há outro boleto deste acordo ou não é a parcela 1: a estrutura só chega pela importação do relatório",
    acao: null,
  },
  ACORDO_CHEGOU_AGUARDANDO_RODADA: {
    rotulo: "Acordo importado · aguardando a rodada horária",
    explica: "o acordo deste boleto já entrou no CRM; a baixa sai na próxima rodada das :40",
    acao: null,
  },
  ALUNO_VINCULADO_SEM_PROVA_DUPLA: {
    rotulo: "Aluno vinculado pela gestão · acordo não encontrado",
    explica: "o pagamento já tem aluno, mas matrícula e nome não o confirmam: o registro à vista exige as duas",
    acao: null,
  },
  IDENTIDADE_DIVERGENTE: {
    rotulo: "Matrícula e nome divergem · acordo não encontrado",
    explica: "a matrícula leva a um aluno e o nome a outro: a identidade precisa de decisão",
    acao: "VINCULAR_ALUNO",
  },
  ALUNO_NAO_IDENTIFICADO: {
    rotulo: "Aluno não identificado · acordo não encontrado",
    explica: "matrícula e nome não apontam, juntos, para um único aluno",
    acao: "VINCULAR_ALUNO",
  },
};

// Enquanto `pagamentos_trava` nao respondeu, "Aguardando acordo · sem acao
// manual" parece diagnostico definitivo e nao e (17/09/2026). A linha diz que
// ainda esta analisando e fica sem acao ate o diagnostico chegar.
export const ANALISANDO_PENDENCIA = "Analisando pendência…";

// `travas` e o mapa pagamento_id -> linha de `pagamentos_trava`, ou null
// enquanto carrega. Sem diagnostico, a linha em AGUARDANDO_ACORDO fica SEM
// acao: acao generica e justamente o que esta regra proibe.
export function acaoDaLinha(item, travas) {
  const estado = estadoDaLinha(item);
  if (item && item.status_conciliacao === "AGUARDANDO_ACORDO") {
    if (!travas) {
      return {
        rotulo: ANALISANDO_PENDENCIA,
        explica: "verificando em que ponto o pagamento travou",
        acao: null,
        trava: null,
        carregando: true,
      };
    }
    const linha = travas[item.pagamento_id];
    const def = linha && TRAVAS_AGUARDANDO_ACORDO[linha.trava];
    if (!def) {
      return {
        rotulo: estado.rotulo,
        explica: "não foi possível verificar em que ponto o pagamento travou; atualize a fila",
        acao: null,
        trava: null,
      };
    }
    return { ...def, trava: linha.trava };
  }
  return {
    rotulo: estado.rotulo,
    explica: estado.explica,
    acao: podeVincularAluno(item) ? "VINCULAR_ALUNO" : null,
    trava: null,
  };
}

export const VALIDACOES_ACORDO_AVISTA = {
  PAGAMENTO_EXISTE: "Pagamento encontrado",
  ESTADO_AGUARDANDO_ACORDO: "Pagamento aguardando acordo",
  FILA_SEM_DECISAO: "Sem decisão anterior na fila",
  PAGAMENTO_NAO_ESTORNADO_NEM_RETROATIVO: "Pagamento não estornado nem retroativo",
  BOLETO_NO_PADRAO: "Boleto no padrão 5 + acordo + parcela",
  BOLETO_PARCELA_0001: "Boleto é a parcela 0001",
  UNICO_BOLETO_DO_ACORDO: "Único boleto deste acordo",
  NUMERO_ULBRA_INEXISTENTE: "Número ULBRA ainda não existe no CRM",
  AUSENCIA_EXPLICADA: "Ausência no relatório explicada",
  MATRICULA_APONTA_UM_ALUNO: "Matrícula aponta para um aluno",
  NOME_APONTA_UM_ALUNO: "Nome aponta para um aluno",
  MATRICULA_E_NOME_MESMO_ALUNO: "Matrícula e nome: o mesmo aluno",
  ALUNO_NAO_ENCERRADO: "Aluno não encerrado à mão",
  VENCIMENTO_NO_ARQUIVO: "Vencimento presente no arquivo",
  VALOR_COMPATIVEL_COM_A_BAIXA: "Valor compatível com a baixa",
  OPERADOR_CADASTRADO: "Operador do pagamento cadastrado",
  TITULOS_ESCOLHIDOS: "Mensalidades escolhidas",
  TITULOS_ELEGIVEIS: "Mensalidades elegíveis",
  SOMA_ATE_O_VALOR_PAGO: "Soma das mensalidades até o valor pago",
  DIFERENCA_DENTRO_DA_MARGEM_SEGURA: "Diferença dentro da margem segura",
  SEM_ACORDO_ATIVO_IDENTICO: "Sem acordo ativo idêntico",
};

export const IMPEDIMENTOS_DE_TITULO = {
  TITULO_DE_OUTRO_ALUNO: "de outro aluno",
  TITULO_E_BOLETO_DE_ACORDO: "é boleto de acordo",
  TITULO_LIGADO_A_OUTRO_ACORDO: "já ligada a outro acordo",
  TITULO_LIQUIDADO_NA_ORIGEM: "liquidada na origem",
  TITULO_NAO_ESTA_EM_ABERTO: "não está em aberto",
  TITULO_SEM_VALOR: "sem valor",
};

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

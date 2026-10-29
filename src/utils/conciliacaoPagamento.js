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
  // Os dois estados abaixo entraram no CHECK do banco depois (20260914190000 e
  // 20260915120000) e continuavam sem rotulo aqui: a tela caia em SEM_ESTADO e
  // dizia "Anterior à regra" para uma linha que TEM estado, e recente.
  ACORDO_CONFIRMADO_SEM_ESTRUTURA: {
    rotulo: "Acordo confirmado, sem estrutura",
    explica: "a negociação está provada no portador 166, mas o acordo não existe no CRM e a estrutura não veio pela API",
  },
  TITULO_ORIGINAL_LIQUIDADO: {
    rotulo: "Título liquidado na origem",
    explica: "a dívida-mãe fechou na Prime; nenhum acordo ou parcela foi criado deste lado",
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
  // Continua aqui porque `conciliacao_encerrar` segue no banco para as rotinas
  // e para os casos ja encerrados por ela. Saiu da TELA em 23/09/2026.
  ENCERRAR_PENDENCIA: "Encerrar pendência",
  FEITO: "Feito",
  REJEITAR: "Rejeitar",
};

// AS DUAS SAIDAS DA FILA MANUAL (23/09/2026). Substituem "Encerrar pendência"
// na tela: a gestao pediu duas decisoes distintas, cada uma com categoria.
// Os valores espelham o catalogo fechado da migration 20260923020000 -- se um
// lado mudar sem o outro, o banco recusa.
export const CONCLUSOES_FEITO = [
  { valor: "ENTRADA_DE_ACORDO", rotulo: "Confirmado como entrada de acordo" },
  { valor: "PARCELA_DE_ACORDO", rotulo: "Confirmado como parcela de acordo" },
  { valor: "JA_TRATADO", rotulo: "Pagamento já tratado corretamente" },
  { valor: "SEM_IMPACTO_FINANCEIRO", rotulo: "Sem impacto financeiro atual" },
  { valor: "OUTRO_CONFIRMADO", rotulo: "Outro motivo confirmado" },
];

export const MOTIVOS_REJEICAO = [
  { valor: "NAO_E_ENTRADA_DE_ACORDO", rotulo: "Não é entrada de acordo" },
  { valor: "NAO_PERTENCE_AO_ACORDO", rotulo: "Não pertence ao acordo indicado" },
  { valor: "SEM_ESTRUTURA_SUFICIENTE", rotulo: "Pagamento sem estrutura suficiente" },
  { valor: "DOCUMENTO_INCOMPATIVEL", rotulo: "Boleto/documento incompatível" },
  { valor: "VALOR_INCOMPATIVEL", rotulo: "Valor incompatível" },
  { valor: "OUTRO", rotulo: "Outro" },
];

// "Outro" sem explicacao encerra a linha sem deixar como relê-la depois. O
// banco recusa dos dois lados; aqui a tela avisa antes de tentar.
const EXIGE_OBSERVACAO = new Set(["OUTRO_CONFIRMADO", "OUTRO"]);

export const FEITO_AVISO =
  "Conclui a conferência e tira a linha da fila. Não baixa parcela, não altera acordo, saldo nem mensalidade.";

export const REJEITAR_AVISO =
  "Decisão de revisão: NÃO apaga nada e NÃO desfaz o pagamento. Só registra o motivo e tira a linha da fila.";

// Uma regra so, usada pelo botao e pelo teste -- para a tela nunca discordar
// do que o banco vai aceitar.
export function finalizacaoInvalida({ acao, escolha, observacao }) {
  const obs = (observacao || "").trim();
  if (acao === "REJEITAR" && !escolha) return "Escolha o motivo da rejeição.";
  if (acao === "FEITO" && !escolha) return "Escolha a conclusão.";
  if (EXIGE_OBSERVACAO.has(escolha) && obs === "") {
    return acao === "REJEITAR"
      ? 'O motivo "Outro" exige observação.'
      : 'A conclusão "Outro motivo confirmado" exige observação.';
  }
  return null;
}

// ENCERRAR NAO E ACAO TECNICA (17/09/2026). E a saida da gestao para a linha
// que nao tem mais o que o sistema resolva sozinho: tira da fila ativa e para
// o reprocessamento, sem tocar em parcela, acordo, saldo ou mensalidade. Por
// isso ela NAO substitui a acao tecnica -- aparece ao lado dela.
export const ENCERRAR_PENDENCIA_AVISO =
  "Só tira a linha da fila e para o reprocessamento. Não baixa parcela, não altera acordo, saldo nem mensalidade.";

// BAIXADO nao esta na fila, e linha anterior a regra (sem estado) nao tem
// pendencia de conciliacao para encerrar -- o banco recusa as duas.
export function podeEncerrarPendencia(item) {
  const estado = item && item.status_conciliacao;
  return Boolean(estado) && estado !== "BAIXADO";
}

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
  // A PREVIA RECUSOU (17/09/2026). A trava vem do banco com o motivo que a
  // propria previa do registro deu; a tela so traduz o codigo. Nenhuma destas
  // tem acao: oferecer "Registrar" aqui seria oferecer o que o registro recusa.
  ACORDO_AVISTA_FORA_DA_MARGEM: {
    rotulo: "Aluno identificado · acordo não encontrado · valor fora da margem segura",
    explica: "o valor pago excede a margem segura sobre as mensalidades em aberto: a simulação recusa o registro",
    acao: null,
  },
  ACORDO_AVISTA_ALUNO_ENCERRADO: {
    rotulo: "Aluno identificado · acordo não encontrado · aluno já encerrado",
    explica: "o aluno já foi encerrado (quitado, baixa realizada ou saldo zero confirmado): abrir acordo nele não cabe neste fluxo",
    acao: null,
  },
  ACORDO_AVISTA_OPERADOR_NAO_CADASTRADO: {
    rotulo: "Aluno identificado · acordo não encontrado · operador do pagamento não cadastrado",
    explica: "a recuperação depende de cadastrar ou resolver o operador do pagamento, que fica com o crédito do acordo",
    acao: null,
  },
  ACORDO_AVISTA_SEM_MENSALIDADE_ELEGIVEL: {
    rotulo: "Aluno identificado · acordo não encontrado · nenhuma mensalidade elegível em aberto",
    explica: "o aluno não tem mensalidade em aberto e livre para este acordo quitar",
    acao: null,
  },
  ACORDO_AVISTA_SEM_COMBINACAO_SEGURA: {
    rotulo: "Aluno identificado · acordo não encontrado · sem combinação segura de mensalidades",
    explica: "as mensalidades em aberto passam do valor pago: não há combinação segura para registrar",
    acao: null,
  },
  ACORDO_AVISTA_OUTRO_BLOQUEIO: {
    rotulo: "Aluno identificado · acordo não encontrado · registro bloqueado pela simulação",
    explica: "a simulação do registro recusa este pagamento por outra validação",
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

// CONFERENCIA MANUAL DA LINHA (23/09/2026). A gestao decidiu NAO reclassificar
// os 34 `AGUARDANDO_ACORDO` por rotina e conferir um a um -- entao a linha
// precisa mostrar, sem sair da fila, o que existe de fato sobre o pagamento.
//
// Tudo aqui e LEITURA de `pagamentos_sem_aluno.evidencias`, que o banco monta
// a partir do que ja esta gravado. Nenhum item sugere acao nem vira vinculo:
// sao fatos, e quem conclui e a pessoa.
//
// Item sem resposta NAO vira linha. "Não" e um fato; ausencia de dado nao e --
// e mostrar "—" ao lado de um rotulo afirmativo faria parecer resposta.
export function evidenciasDaLinha(item) {
  const e = (item && item.evidencias) || {};
  const linhas = [];

  if (e.acordo_prefixo) {
    linhas.push({
      chave: "acordo_no_crm",
      rotulo: "Acordo no CRM",
      valor: e.acordo_no_crm
        ? `sim · ${e.acordo_status || "sem status"}`
        : "não — o acordo deste boleto não existe aqui",
      alerta: !e.acordo_no_crm,
    });
  }
  if (typeof e.parcela_com_este_boleto === "boolean") {
    linhas.push({
      chave: "parcela",
      rotulo: "Parcela com este boleto",
      valor: e.parcela_com_este_boleto ? `sim · ${e.parcela_status || "sem status"}` : "não",
      // Alerta so quando a AUSENCIA e noticia: com o acordo no CRM, faltar a
      // parcela e o problema em si (falta amarrar). Sem o acordo no CRM, a
      // parcela nao existir e consequencia -- pintar as duas de vermelho faria
      // o estado normal de "aguardando acordo" parecer duas falhas.
      alerta: !e.parcela_com_este_boleto && e.acordo_no_crm === true,
    });
  }
  if (typeof e.cpf_no_portador_166 === "boolean") {
    linhas.push({
      chave: "portador_166",
      rotulo: "CPF no portador 166",
      // O 166 e a carteira de negociacao: o CPF estar la prova que houve
      // acordo, mesmo quando a estrutura dele nunca chegou ao CRM.
      valor: e.cpf_no_portador_166 ? "sim — negociação confirmada" : "não",
    });
  }
  if (e.consulta_estrutura) {
    linhas.push({
      chave: "estrutura",
      rotulo: "Consulta de estrutura no Prime",
      valor: ROTULO_CONSULTA_ESTRUTURA[e.consulta_estrutura] || e.consulta_estrutura,
    });
  }
  if (e.documento) {
    linhas.push({ chave: "documento", rotulo: "Documento", valor: e.documento });
  }
  if (Number(e.tentativas) > 0) {
    linhas.push({
      chave: "tentativas",
      rotulo: "Avaliações automáticas",
      valor: `${e.tentativas}${e.ultima_tentativa_em ? ` · última em ${dataHoraCurta(e.ultima_tentativa_em)}` : ""}`,
    });
  }
  if (e.evidencia_origem) {
    linhas.push({
      chave: "origem",
      rotulo: "Origem da evidência",
      valor: ROTULO_EVIDENCIA_ORIGEM[e.evidencia_origem] || e.evidencia_origem,
    });
  }
  if (linhas.length === 0) {
    return [{ chave: "nenhuma", rotulo: "Evidências", valor: "nenhuma registrada até agora" }];
  }
  return linhas;
}

export const ROTULO_CONSULTA_ESTRUTURA = {
  NAO_ENCONTRADA: "não encontrada — a API do Prime não devolve a estrutura",
  ENCONTRADA: "encontrada",
  ERRO: "erro na consulta",
};

export const ROTULO_EVIDENCIA_ORIGEM = {
  PRIME_PORTADOR_MEMBRO: "espelho do portador 166",
  PRIME_API_LIVE: "consulta ao vivo à API do Prime",
};

function dataHoraCurta(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

// REGRA DE CONFERENCIA, registrada pela gestao em 23/09/2026:
//
//   "se o numero do acordo identificado no boleto for mais novo que o maior
//    acordo existente do aluno no CRM, nao forcar vinculo com acordo antigo"
//
// POR QUE ELA EXISTE. O boleto de acordo e 5 + acordo(6) + parcela(4), entao o
// prefixo diz de QUAL acordo aquele pagamento e. Quando esse numero e maior que
// todos os que o aluno tem aqui, o pagamento e de um acordo que o CRM ainda nao
// recebeu -- re-acordo. A parcela antiga que "quase bate" no valor e de outro
// acordo, e casar as duas seria inventar um vinculo.
//
// MEDIDO na fila de 23/09/2026: dos 39 pendentes, 34 caem nesta situacao --
// 21 alunos sem acordo nenhum no CRM e 13 com acordo do boleto mais novo. So 2
// eram conciliacao de verdade. Nao e excecao: e a maioria.
//
// COMO DECIDIR. Classificar como acordo/re-acordo AUSENTE do CRM -- FEITO com
// "Confirmado como entrada de acordo" ou "Confirmado como parcela de acordo",
// conforme a tela do Prime mostrar -- e escrever o NUMERO IDENTIFICADO na
// observacao. E esse numero que permite reencontrar o caso quando o acordo
// finalmente entrar; sem ele a decisao vira um "conferido" sem rastro.
//
// O que NAO fazer: vincular ao acordo antigo, criar parcela para receber o
// pagamento, ou baixar contra a parcela de outro acordo porque o valor parece.
// Valor parecido nao e prova -- aqui as duas variaveis independentes (numero do
// acordo e vencimento) dizem que sao coisas diferentes.
export const REGRA_ACORDO_MAIS_NOVO =
  "Se o acordo do boleto for mais novo que o maior acordo do aluno no CRM, é re-acordo ausente: " +
  "não vincular ao acordo antigo. Concluir como entrada/parcela de acordo e anotar o número na observação.";

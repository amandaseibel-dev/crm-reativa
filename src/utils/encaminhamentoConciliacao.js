// ENCAMINHAMENTO DA PENDÊNCIA CLASSIFICADA — o vocabulário, fora do JSX.
//
// POR QUE EXISTE. `vw_fila_pagamento_triagem` declara uma ação para 89
// pagamentos (47 CONFERIR_E_ENCERRAR, 42 ESCOLHER_ALUNO, medido em 26/10/2026)
// e nenhuma tela a oferecia. A Etapa 2 abre essa porta. Aqui mora só o
// vocabulário e as regras que a tela e os testes têm de ler IGUAIS — nenhuma
// classificação é decidida neste arquivo: ela é toda do banco, como em
// `filaPagamentoTriagem.js`.
//
// A REGRA QUE ORGANIZA TUDO: a tela nunca inventa o que vai acontecer. Ela
// traduz códigos que a prévia do banco devolveu. Texto montado na tela sobre
// efeito financeiro é exatamente como se promete o que o banco não faz.

// AS DUAS AÇÕES, e o que cada uma de fato faz. `passos` espelha o array que a
// prévia devolve: se o banco ganhar um passo e este mapa não, o teste reprova.
export const ACOES_ENCAMINHAMENTO = {
  CONFERIR_E_ENCERRAR: {
    rotulo: "Conferir e encerrar",
    verbo: "Encerrar a pendência",
    explica:
      "A parcela deste boleto já estava paga antes do pagamento entrar, e o dinheiro já está " +
      "refletido. Encerrar registra a conferência e tira a linha da fila.",
    // As duas frases que a gestão precisa ler antes de confirmar: o que muda e
    // o que NÃO muda. A segunda é a que impede a leitura "isto deu baixa".
    aviso:
      "Registra a decisão e move o pagamento para “encerrado sem efeito financeiro”. " +
      "Não dá baixa, não quita, não altera parcela, acordo, título nem saldo.",
    passos: ["REGISTRAR_DECISAO_RESOLVIDO_AUTOMATICO", "MOVER_PARA_ENCERRADO_SEM_EFEITO_FINANCEIRO"],
    resultado: "PENDENCIA_ENCERRADA_SEM_EFEITO_FINANCEIRO",
    exigeAluno: false,
  },
  ESCOLHER_ALUNO: {
    rotulo: "Escolher o aluno sugerido",
    verbo: "Vincular o aluno escolhido",
    explica:
      "A fila sugere um ou mais alunos para este pagamento. Vincular diz de quem é o dinheiro " +
      "que já estava lançado — a conciliação continua, agora com o aluno certo.",
    aviso:
      "Grava o vínculo como decisão da gestão e fecha a linha da fila. " +
      "Não dá baixa, não quita e não altera parcela, acordo, título nem saldo.",
    passos: ["VINCULAR_ALUNO_ESCOLHIDO"],
    resultado: "PAGAMENTO_VINCULADO_AO_ALUNO",
    exigeAluno: true,
  },
};

// O RESULTADO ESPERADO, em português. O banco devolve código; quem escreve a
// frase é a tela, e a frase diz o LIMITE junto com o efeito — como o rótulo
// `BAIXA_REGISTRADA_CRM` carrega o dele.
export const RESULTADOS = {
  PENDENCIA_ENCERRADA_SEM_EFEITO_FINANCEIRO:
    "a pendência sai da fila e do contador, com o motivo preservado no histórico do arquivo. " +
    "Nenhum dinheiro é movido.",
  PAGAMENTO_VINCULADO_AO_ALUNO:
    "o pagamento passa a apontar para o aluno escolhido e a linha sai da fila. " +
    "O estado da conciliação não muda por isto.",
};

// AS RECUSAS, uma frase cada. Recusa sem nome é o que faz a pessoa clicar de
// novo; recusa nomeada é informação.
export const MOTIVOS_RECUSA = {
  SEM_PENDENCIA_NA_TRIAGEM:
    "este pagamento não está mais na triagem de pendências — atualize a fila.",
  SEM_ACAO_SUGERIDA:
    "a triagem não declara ação para este caso. Ele precisa de conferência caso a caso.",
  ACAO_NAO_IMPLEMENTADA:
    "a triagem declara uma ação que esta tela ainda não oferece.",
  ACAO_DIVERGE_DA_SUGERIDA:
    "a classificação mudou depois que a tela carregou — atualize a fila e confira de novo.",
  ALUNO_NAO_INFORMADO: "escolha qual aluno antes de confirmar.",
  ALUNO_FORA_DAS_SUGESTOES:
    "o aluno escolhido não está entre as sugestões da fila. Para vincular outro, use a busca manual.",
  PASSO_1_RECUSADO:
    "a conferência da parcela já paga não passou em todas as validações.",
  VINCULO_RECUSADO: "o vínculo do aluno foi recusado pelo banco.",
  SEM_SUGESTAO_DE_ALUNO: "a fila não tem sugestão de aluno para este pagamento.",
};

// AS 8 VALIDAÇÕES de `PARCELA_JA_PAGA_CONFERIDA`, com o nome que a prévia usa.
// Código desconhecido NÃO desaparece: devolve o próprio código, para a tela
// mostrar algo verdadeiro em vez de vazio — mesma decisão de
// `rotuloSubcategoria`.
export const VALIDACOES_JA_PAGA = {
  PENDENCIA_ABERTA_JA_PAGA: "Pendência aberta, em “parcela já paga”",
  BOLETO_NO_PADRAO: "Boleto no padrão 5 + acordo + parcela",
  PARCELA_DO_BOLETO_PAGA: "A parcela deste boleto está PAGO",
  UNICO_PAGAMENTO_DO_BOLETO: "É o único pagamento deste boleto",
  VALOR_REFLETIDO_NA_PARCELA: "Valor pago compatível com a parcela",
  ACORDO_FECHA_PAGAMENTO_A_PAGAMENTO: "O acordo fecha pagamento a pagamento",
  REFERENCIA_ANTIGA_DESLOCADA: "A referência da baixa antiga estava deslocada",
  SEM_BAIXA_DEVOLVIDA: "Nenhuma baixa devolvida na parcela",
};

export function rotuloValidacao(codigo) {
  if (!codigo) return "—";
  return VALIDACOES_JA_PAGA[codigo] || codigo;
}

export function rotuloRecusa(codigo) {
  if (!codigo) return "não foi possível concluir — motivo não informado.";
  return MOTIVOS_RECUSA[codigo] || `não foi possível concluir (${codigo}).`;
}

export function rotuloResultado(codigo) {
  if (!codigo) return "";
  return RESULTADOS[codigo] || "";
}

// A LINHA TEM ENCAMINHAMENTO? Só quando a triagem declarou uma ação QUE ESTA
// TELA IMPLEMENTA. A segunda metade é o que impede botão morto: a triagem pode
// ganhar uma ação nova antes da tela, e nesse caso a linha continua sem botão.
//
// Linha já decidida não tem encaminhamento: ela é o caso dos 33 que a Etapa 1
// resolve por backfill, com autorização própria — não por esta porta.
export function podeEncaminhar(triagem) {
  if (!triagem) return false;
  if (triagem.decisao) return false;
  const acao = triagem.acao_sugerida;
  return Boolean(acao && ACOES_ENCAMINHAMENTO[acao]);
}

// UMA REGRA SÓ, usada pelo botão e pelo teste — para a tela nunca discordar do
// que o banco vai aceitar. Mesma decisão de `finalizacaoInvalida`.
//
// Devolve a frase do impedimento, ou null quando pode confirmar.
export function impedimentoDoEncaminhamento({ previa, alunoId } = {}) {
  if (!previa) return "Carregue a prévia antes de confirmar.";
  if (previa.ok === false) return rotuloRecusa(previa.motivo);

  const def = ACOES_ENCAMINHAMENTO[previa.acao];
  if (!def) return rotuloRecusa("ACAO_NAO_IMPLEMENTADA");

  if (previa.aprovado !== true) {
    const bloqueios = Array.isArray(previa.bloqueios) ? previa.bloqueios : [];
    if (bloqueios.length === 0) return "A prévia não aprovou este caso.";
    // Bloqueio com nome próprio ganha a própria frase; os outros viram a lista
    // das validações que faltaram, com o rótulo de cada uma.
    if (bloqueios.length === 1 && MOTIVOS_RECUSA[bloqueios[0]]) {
      return rotuloRecusa(bloqueios[0]);
    }
    return `A prévia não aprovou: ${bloqueios.map(rotuloValidacao).join("; ")}.`;
  }

  if (def.exigeAluno && !alunoId) return rotuloRecusa("ALUNO_NAO_INFORMADO");

  if (def.exigeAluno && alunoId) {
    const sugestoes = Array.isArray(previa.sugestoes) ? previa.sugestoes : [];
    if (!sugestoes.some((s) => s && s.aluno_id === alunoId)) {
      return rotuloRecusa("ALUNO_FORA_DAS_SUGESTOES");
    }
  }

  return null;
}

// AS VALIDAÇÕES PARA A TELA, já traduzidas e na ordem que o banco mandou.
// Prévia sem validações (ESCOLHER_ALUNO não tem) devolve lista vazia, e a tela
// mostra as sugestões no lugar — não um quadro vazio com título.
export function validacoesDaPrevia(previa) {
  const lista = Array.isArray(previa?.validacoes) ? previa.validacoes : [];
  return lista
    .filter((v) => v && v.codigo)
    .map((v) => ({
      codigo: v.codigo,
      rotulo: rotuloValidacao(v.codigo),
      ok: v.ok === true,
      detalhe: v.detalhe || "",
    }));
}

// O TEXTO DA CONFIRMAÇÃO. Uma frase, com o que vai acontecer e o que não vai.
// `moeda` entra por parâmetro porque a formatação é da tela, não desta regra —
// e porque o teste precisa afirmar o texto sem depender de locale.
export function textoDaConfirmacao({ previa, alunoNome, moeda } = {}) {
  const def = ACOES_ENCAMINHAMENTO[previa?.acao];
  if (!def) return "";
  const valor = typeof moeda === "function" ? moeda(previa?.pagamento?.valor_pago) : "";
  const alvo = def.exigeAluno && alunoNome ? ` ao aluno ${alunoNome}` : "";
  return `${def.verbo}${alvo}${valor ? ` — pagamento de ${valor}` : ""}? ${def.aviso}`;
}

// O QUE A ETAPA 2 NÃO FAZ, dito na tela em voz alta. A fila inteira já carrega
// `AVISO_PROJECAO`; este aviso é sobre a AÇÃO, não sobre o dinheiro do dia.
export const ENCAMINHAMENTO_AVISO =
  "Encaminhar é decisão de conferência: nenhuma destas ações dá baixa, quita, reatribui caso " +
  "ou altera valor. Toda confirmação fica registrada na auditoria com quem decidiu e quando.";

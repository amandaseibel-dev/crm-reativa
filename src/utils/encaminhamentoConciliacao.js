// ENCAMINHAMENTO DA PENDÊNCIA CLASSIFICADA — o vocabulário, fora do JSX.
//
// POR QUE EXISTE. `vw_fila_pagamento_triagem` declara `CONFERIR_E_ENCERRAR` para
// 47 pagamentos (R$ 40.663,34, medido em 26/10/2026) e nenhuma tela a oferecia:
// a ação aparecia só em teste e na QuitacaoSugerida. A Etapa 2 abre essa porta.
//
// ESCOPO: UMA AÇÃO. `ESCOLHER_ALUNO` foi retirada desta etapa por decisão da
// gestão em 26/10/2026, e não tem caminho nenhum aqui — nem mapa, nem rótulo,
// nem botão. A razão, para não voltar por esquecimento: a porta dela seria
// `pagamento_vincular_aluno`, que chama `pagamento_conciliar_um(.., true)` e
// PODE DAR BAIXA (154 de 212 vínculos manuais terminaram em BAIXADO), e 32 dos
// 42 casos já têm aluno vinculado — contra a regra de 16/09/2026 que este mesmo
// projeto escreveu em `podeVincularAluno`.
//
// A funcionalidade ANTIGA não mudou: a busca manual de aluno na fila continua
// como estava, com o próprio aviso e o próprio portão. Esta etapa apenas não
// abre uma segunda porta para ela.
//
// Aqui mora só o vocabulário e as regras que a tela e os testes têm de ler
// IGUAIS — nenhuma classificação é decidida neste arquivo: ela é toda do banco,
// como em `filaPagamentoTriagem.js`.
//
// A REGRA QUE ORGANIZA TUDO: a tela nunca inventa o que vai acontecer. Ela
// traduz códigos que a prévia do banco devolveu. Texto montado na tela sobre
// efeito financeiro é exatamente como se promete o que o banco não faz.

// A AÇÃO DESTA ETAPA. `passos` espelha o array que a prévia devolve: se o banco
// ganhar um passo e este mapa não, o teste reprova.
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
  },
};

// O RESULTADO ESPERADO, em português. O banco devolve código; quem escreve a
// frase é a tela, e a frase diz o LIMITE junto com o efeito — como o rótulo
// `BAIXA_REGISTRADA_CRM` carrega o dele.
export const RESULTADOS = {
  PENDENCIA_ENCERRADA_SEM_EFEITO_FINANCEIRO:
    "a pendência sai da fila e do contador, com o motivo preservado no histórico do arquivo. " +
    "Nenhum dinheiro é movido.",
};

// AS RECUSAS, uma frase cada. Recusa sem nome é o que faz a pessoa clicar de
// novo; recusa nomeada é informação.
export const MOTIVOS_RECUSA = {
  SEM_PENDENCIA_NA_TRIAGEM:
    "este pagamento não está mais na triagem de pendências — atualize a fila.",
  SEM_ACAO_SUGERIDA:
    "a triagem não declara ação para este caso. Ele precisa de conferência caso a caso.",
  // A recusa dos 42 `ESCOLHER_ALUNO`: a pendência continua visível e esta
  // interface diz, sem rodeio, que não é ela que resolve o caso.
  ACAO_FORA_DO_ESCOPO_DESTA_ETAPA:
    "a triagem declara uma ação que esta tela não executa. Use o caminho próprio dela na fila.",
  ACAO_NAO_IMPLEMENTADA:
    "a triagem declara uma ação que esta tela ainda não oferece.",
  ACAO_DIVERGE_DA_SUGERIDA:
    "a classificação mudou depois que a tela carregou — atualize a fila e confira de novo.",
  PASSO_1_RECUSADO:
    "a conferência da parcela já paga não passou em todas as validações.",
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
// ETAPA IMPLEMENTA. A segunda metade é o que mantém `ESCOLHER_ALUNO` (e
// qualquer ação futura) sem botão: a triagem pode declarar o que quiser, e a
// linha só ganha porta quando esta etapa souber executá-la.
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
export function impedimentoDoEncaminhamento({ previa } = {}) {
  if (!previa) return "Carregue a prévia antes de confirmar.";
  if (previa.ok === false) return rotuloRecusa(previa.motivo);

  const def = ACOES_ENCAMINHAMENTO[previa.acao];
  if (!def) return rotuloRecusa("ACAO_FORA_DO_ESCOPO_DESTA_ETAPA");

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

  return null;
}

// AS VALIDAÇÕES PARA A TELA, já traduzidas e na ordem que o banco mandou.
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
export function textoDaConfirmacao({ previa, moeda } = {}) {
  const def = ACOES_ENCAMINHAMENTO[previa?.acao];
  if (!def) return "";
  const valor = typeof moeda === "function" ? moeda(previa?.pagamento?.valor_pago) : "";
  return `${def.verbo}${valor ? ` — pagamento de ${valor}` : ""}? ${def.aviso}`;
}

// O QUE A ETAPA 2 NÃO FAZ, dito na tela em voz alta. A fila inteira já carrega
// `AVISO_PROJECAO`; este aviso é sobre a AÇÃO, não sobre o dinheiro do dia.
export const ENCAMINHAMENTO_AVISO =
  "Encerrar aqui é decisão de conferência: não dá baixa, não quita, não vincula aluno, não " +
  "reatribui caso e não altera valor. Toda confirmação fica registrada na auditoria com quem " +
  "decidiu e quando.";

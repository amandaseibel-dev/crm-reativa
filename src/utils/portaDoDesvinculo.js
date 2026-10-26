// QUAL PORTA USAR PARA SOLTAR UMA MENSALIDADE DE UM ACORDO -- a regra,
// separada da tela para poder ser testada.
//
// São DUAS perguntas diferentes, e confundi-las é o defeito que esta regra
// evita (medido em produção em 26/10/2026):
//
//   1. "esta mensalidade está negociada num acordo vivo e quero soltá-la"
//      -> `desvincular_titulos_acordo`. A mensalidade está NEGOCIADO, nenhum
//         dinheiro foi atribuído a ela, e voltar para ABERTO não desfaz
//         pagamento nenhum.
//
//   2. "esta mensalidade aparece QUITADA e o acordo não a pagou"
//      -> `titulo_atribuicao_remover` (E7). Aqui a tela está desfazendo uma
//         QUITAÇÃO, e isso exige prova de que o acordo não cobriu aquela
//         mensalidade. `desvincular_titulos_acordo` força ABERTO sem olhar
//         lastro nenhum: no título legitimamente pago, devolve à cobrança uma
//         dívida já paga.
//
// A marca de proveniência conta tanto quanto o par situacao/status: um título
// com `origem_liquidacao` preenchido já afirmou POR QUE fechou, e apagar essa
// afirmação pela porta de soltar vínculo é perder o lastro.
export const PORTA_DESVINCULAR = "DESVINCULAR";
export const PORTA_ATRIBUICAO_REMOVER = "ATRIBUICAO_REMOVER";

const STATUS_QUITADO = ["quitada", "quitado", "paga", "pago"];

export function portaDoDesvinculo(titulo) {
  const t = titulo || {};
  const situacao = String(t.situacao || "").toUpperCase();
  const status = String(t.status || "").toLowerCase();
  const temProveniencia = String(t.origem_liquidacao || "").trim() !== "";
  const temEncerramento = t.origem_encerramento != null && String(t.origem_encerramento).trim() !== "";

  if (situacao === "PAGO" || STATUS_QUITADO.includes(status)) {
    return {
      porta: PORTA_ATRIBUICAO_REMOVER,
      motivo: "A mensalidade está marcada como quitada: soltá-la desfaz uma quitação, "
        + "e isso exige conferir se o acordo realmente pagou esta dívida.",
    };
  }
  if (temEncerramento) {
    return {
      porta: PORTA_ATRIBUICAO_REMOVER,
      motivo: "A mensalidade foi encerrada administrativamente — a saída tem porta própria.",
    };
  }
  if (temProveniencia) {
    return {
      porta: PORTA_ATRIBUICAO_REMOVER,
      motivo: "A mensalidade registra de onde veio a liquidação: desfazer isso exige conferência.",
    };
  }
  return { porta: PORTA_DESVINCULAR, motivo: null };
}

// O resumo da simulação, em uma frase que a gestão consegue conferir contra a
// tela do Prime antes de confirmar. Nunca arredonda para "aproximadamente".
export function resumoDaCobertura(cobertura) {
  const c = cobertura || {};
  const brl = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const descobertoDepois = Number(c.descoberto_depois || 0);
  const sobra = descobertoDepois <= 0
    ? "e passa a sobrar " + brl(Math.abs(descobertoDepois)) + " de cobertura"
    : "e ainda restam " + brl(descobertoDepois) + " sem cobertura";
  return "O acordo recebeu " + brl(c.recebido_no_acordo)
    + " e carrega " + brl(c.quitadas_antes) + " de mensalidade quitada — faltam "
    + brl(c.descoberto_antes) + ". Retirando esta mensalidade de " + brl(c.valor_deste_titulo)
    + ", o acordo passa a carregar " + brl(c.quitadas_depois) + " " + sobra + ".";
}

// A tela DEGRADA SOZINHA: quando a E7 ainda não está aplicada em produção, a
// chamada volta erro de função inexistente e o texto diz exatamente isso, em
// vez de cair na porta antiga (que é o defeito) ou mostrar "erro".
const RECUSAS = {
  LIQUIDACAO_OFICIAL_COMPROVADA:
    "Não é possível: a Prime registra esta mensalidade como liquidada oficialmente. A dívida foi concluída.",
  ENCERRADO_ADMINISTRATIVAMENTE:
    "Não é possível por aqui: a mensalidade foi encerrada pela Conferência Prime, que tem porta própria.",
  TITULO_DE_ACORDO:
    "Não é possível: este é o boleto do próprio acordo, não uma mensalidade.",
  PROVENIENCIA_DE_OUTRO_ACORDO:
    "Não é retirar, é corrigir: o dinheiro que quitou esta mensalidade entrou em OUTRO acordo. "
    + "Mover a atribuição para o acordo certo é outra operação.",
  TITULO_TEM_PAGAMENTO_PROPRIO:
    "Não é possível: existe pagamento identificado no número desta mensalidade. "
    + "Reabri-la cobraria de novo quem já pagou.",
  ACORDO_COBRE_AS_MENSALIDADES:
    "Nada a retirar: o acordo recebeu o suficiente para as mensalidades que quitou.",
  REMOCAO_NAO_FECHA_A_CONTA:
    "Retirar só esta mensalidade não resolve o descoberto do acordo — confira a composição no Prime antes de decidir.",
  NAO_ESTA_QUITADO:
    "A mensalidade não está quitada: use o botão de desvincular.",
  SEM_VINCULO_ATIVO_NESTE_ACORDO:
    "Não há vínculo ativo entre esta mensalidade e este acordo.",
  MOTIVO_OBRIGATORIO: "Escreva o motivo antes de confirmar.",
  JA_REMOVIDO: "Já estava retirada — nada a fazer.",
  TITULO_NAO_ENCONTRADO: "Mensalidade não encontrada.",
  ACORDO_NAO_ENCONTRADO: "Acordo não encontrado.",
  PARAMETROS_INCOMPLETOS: "Faltou informar a mensalidade ou o acordo.",
};

export function mensagemDaRecusa(resposta, erro) {
  const texto = String(erro?.message || "");
  if (/does not exist|could not find the function|schema cache/i.test(texto)) {
    return "Esta correção ainda não está disponível no sistema: a função de retirar atribuição "
      + "não foi aplicada em produção. Nada foi alterado.";
  }
  if (/somente|gestao|gestão|diretoria|42501|permission denied/i.test(texto)) {
    return "Retirar atribuição de mensalidade é decisão da gestão financeira ou da diretoria.";
  }
  const codigo = resposta?.motivo || resposta?.erro || null;
  if (codigo && RECUSAS[codigo]) return RECUSAS[codigo];
  if (codigo) return "Não foi possível retirar a atribuição (" + codigo + ").";
  if (texto) return "Não foi possível retirar a atribuição. Nada foi alterado.";
  return "Não foi possível retirar a atribuição. Nada foi alterado.";
}

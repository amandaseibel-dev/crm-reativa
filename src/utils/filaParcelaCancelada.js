// Fila de excecoes: pagamento identificado em parcela/acordo CANCELADO.
// Funcoes PURAS. Nao consultam, nao gravam, nao baixam, nao quitam.
//
// Por que existe um modulo so para o "selo": a analise F1.b (PR #692) classifica um
// pagamento como CANDIDATO_DETERMINISTICO olhando identificador e identidade, e NAO
// le `parcelas.status` nem `acordos.status`. Logo, ela apresentaria como candidato uma
// parcela CANCELADA de um acordo CANCELADO sem nenhum aviso -- medido no codigo da
// branch em 19/10/2026. `selarCancelamento` e a guarda: nenhuma apresentacao de
// candidato passa por aqui sem o selo, e o teste de invariante prova isso.
//
// Esta PR NAO altera a #692. Quando ela for mesclada, o painel dela deve passar o
// resultado por `selarCancelamento` antes de exibir -- e e isso que torna a guarda
// efetiva no produto inteiro, nao so nesta tela.

export const CLASSIFICACOES = ["COMPROVADO", "SINAL_FORTE", "INVESTIGAR", "SO_VINCULO_BAIXA"];

export const ROTULO_CLASSIFICACAO = {
  COMPROVADO: "Comprovado",
  SINAL_FORTE: "Sinal forte",
  INVESTIGAR: "Investigar",
  SO_VINCULO_BAIXA: "Só vínculo/baixa",
};

export const EXPLICACAO_CLASSIFICACAO = {
  COMPROVADO:
    "Pagamento sem baixa, parcela aberta hoje com o valor exato pago e acordo substituto criado na janela do cancelamento.",
  SINAL_FORTE:
    "Pagamento sem baixa e parcela aberta hoje com o valor exato pago, mas sem substituto na janela — conferir se é a mesma obrigação.",
  INVESTIGAR:
    "Pagamento sem baixa e o aluno tem saldo de acordo aberto, mas nenhum valor casa exatamente. Exposição, não duplicidade provada.",
  SO_VINCULO_BAIXA:
    "Não há cobrança a corrigir: ou o pagamento já tem baixa equivalente, ou o aluno não tem nada de acordo em aberto. Falta crédito/vínculo.",
};

export const ROTULO_ESCOPO = {
  PARCELA_CANCELADA: "Parcela cancelada",
  ACORDO_CANCELADO_PARCELA_ABERTA: "Acordo cancelado, parcela ainda aberta",
  ACORDO_CANCELADO_PARCELA_PAGO: "Acordo cancelado, parcela já paga",
};

const texto = (v) => (v == null ? "" : String(v).trim().toUpperCase());

/**
 * Sela a apresentacao de um resultado de identificacao com o estado de cancelamento.
 *
 * Recebe o resultado como ele vem do motor (`{ situacao, motivo, ... }`) e os status
 * REAIS da parcela e do acordo. Devolve o mesmo resultado mais:
 *   - `cancelado`: true quando parcela ou acordo esta cancelado;
 *   - `selos`: lista dos avisos a exibir, na ordem;
 *   - `apresentavel_como_candidato`: FALSE sempre que ha cancelamento.
 *
 * A regra e deliberadamente de mao unica: a funcao NUNCA promove nada a candidato,
 * so rebaixa. Status desconhecido (nulo) nao e tratado como "nao cancelado" por
 * conveniencia -- entra como `ESTADO_NAO_CONFERIDO`, que tambem bloqueia, porque
 * apresentar candidato sem saber o estado da parcela foi exatamente a falha medida.
 */
export function selarCancelamento(resultado, { status_parcela, status_acordo } = {}) {
  const base = resultado && typeof resultado === "object" ? resultado : {};
  const parcela = texto(status_parcela);
  const acordo = texto(status_acordo);
  const selos = [];

  if (parcela === "CANCELADA") selos.push("PARCELA_CANCELADA");
  if (acordo === "CANCELADO") selos.push("ACORDO_CANCELADO");
  if (!parcela || !acordo) selos.push("ESTADO_NAO_CONFERIDO");

  const cancelado = selos.includes("PARCELA_CANCELADA") || selos.includes("ACORDO_CANCELADO");
  const eraCandidato =
    texto(base.situacao) === "CANDIDATO_DETERMINISTICO" ||
    texto(base.situacao) === "CANDIDATOS_IDENTIFICADOS";

  return {
    ...base,
    cancelado,
    selos,
    // Candidato so se apresenta como candidato quando o estado foi conferido E nada
    // esta cancelado. Qualquer outra combinacao exige o aviso na tela.
    apresentavel_como_candidato: eraCandidato && !cancelado && selos.length === 0,
  };
}

/** Texto curto do selo, para a tela. Nunca vazio quando ha selo. */
export function textoDoSelo(selo) {
  if (selo === "PARCELA_CANCELADA") return "parcela CANCELADA";
  if (selo === "ACORDO_CANCELADO") return "acordo CANCELADO";
  if (selo === "ESTADO_NAO_CONFERIDO") return "estado da parcela não conferido";
  return String(selo ?? "");
}

/**
 * Filtra a fila. Todo filtro ausente significa "nao filtra por isso" -- nunca
 * significa "mostra menos", para a contagem da tela bater com a do banco.
 */
export function filtrarFila(linhas, filtros = {}) {
  const {
    escopo = "PARCELA_CANCELADA",
    classificacao = null,
    somenteSemBaixa = false,
    somenteComCopiaAtiva = false,
    somenteCobrancaPotencial = false,
  } = filtros;
  const lista = Array.isArray(linhas) ? linhas : [];
  return lista.filter((l) => {
    if (escopo && escopo !== "TODOS" && l.escopo !== escopo) return false;
    if (classificacao && l.classificacao !== classificacao) return false;
    if (somenteSemBaixa && l.tem_baixa_equivalente) return false;
    if (somenteComCopiaAtiva && !(Number(l.copia_ativa_mesmo_numero) > 0)) return false;
    if (somenteCobrancaPotencial && !cobrancaPotencialmenteIndevida(l)) return false;
    return true;
  });
}

/**
 * Cobranca potencialmente indevida: o dinheiro entrou, nao foi creditado, e existe
 * hoje parcela aberta com o MESMO valor. Sem o casamento de valor e exposicao, nao
 * cobranca indevida -- e a distincao que impede tratar teto como fato.
 */
export function cobrancaPotencialmenteIndevida(linha) {
  if (!linha) return false;
  return (
    !linha.tem_baixa_equivalente &&
    Number(linha.saldo_acordo_aberto) > 0 &&
    Number(linha.parcelas_abertas_mesmo_valor) > 0
  );
}

/** Totais da fila, para o cabecalho. Soma o que esta na lista recebida, nada mais. */
export function totaisDaFila(linhas) {
  const lista = Array.isArray(linhas) ? linhas : [];
  const cent = (v) => Math.round(Number(v || 0) * 100);
  const soma = (f) => lista.reduce((a, l) => a + (f(l) ? cent(l.valor_pago) : 0), 0) / 100;
  const alunos = new Set(lista.map((l) => String(l.aluno_id ?? ""))).size;
  return {
    pagamentos: lista.length,
    alunos,
    valor: soma(() => true),
    valor_sem_baixa: soma((l) => !l.tem_baixa_equivalente),
    cobranca_potencial: lista.filter(cobrancaPotencialmenteIndevida).length,
    sem_identidade: lista.filter((l) => !l.identidade_comprovada).length,
    por_classificacao: CLASSIFICACOES.reduce((acc, c) => {
      acc[c] = lista.filter((l) => l.classificacao === c).length;
      return acc;
    }, {}),
  };
}

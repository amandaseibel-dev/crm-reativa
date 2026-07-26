// Regras (puras) da aba "Suspeitas de pagamentos duplicados".
//
// Indício OBJETIVO de duplicidade = a MESMA referência bancária
// (numero_parcela_completo) aparece em mais de um pagamento. NÃO é suspeita
// por mesmo nome, mesmo valor, mesma data, nome ambíguo, aluno não localizado
// nem por importação SUBSTITUIDA sem repetição da referência.
//
// Funções puras (sem banco/rede) para poder testar a regra isoladamente e
// reaproveitar no componente.

export const STATUS_SUSPEITA = {
  PENDENTE: "PENDENTE_VALIDACAO",
  LEGITIMO: "LEGITIMO",
  DUPLICIDADE: "DUPLICIDADE_CONFIRMADA",
};

export const DECISOES_PERMITIDAS = [STATUS_SUSPEITA.LEGITIMO, STATUS_SUSPEITA.DUPLICIDADE];

/**
 * Agrupa pagamentos por referência bancária (numero_parcela_completo) e retorna
 * SOMENTE os grupos com indício objetivo (a mesma referência aparece 2+ vezes).
 * Ignora linhas sem referência e linhas já estornadas.
 *
 * @param {Array<object>} pagamentos linhas com {numero_parcela_completo, valor_pago, estornado?}
 * @returns {Array<{chave:string, linhas:object[]}>}
 */
export function agruparSuspeitasPorReferencia(pagamentos) {
  const porChave = new Map();
  for (const p of pagamentos || []) {
    const chave = p?.numero_parcela_completo;
    if (!chave) continue; // sem identificador bancário -> não é indício objetivo
    if (p?.estornado) continue; // linha já estornada não conta
    if (!porChave.has(chave)) porChave.set(chave, []);
    porChave.get(chave).push(p);
  }
  const grupos = [];
  for (const [chave, linhas] of porChave.entries()) {
    if (linhas.length > 1) grupos.push({ chave, linhas });
  }
  return grupos;
}

/**
 * Sugestão APENAS VISUAL da linha suspeita: a de MENOR valor do grupo.
 * Não confirma duplicidade e não decide nada. Retorna null se não der para
 * sugerir (menos de 2 linhas ou empate de valor).
 */
export function sugerirLinhaSuspeita(linhas) {
  if (!Array.isArray(linhas) || linhas.length < 2) return null;
  const ordenadas = [...linhas].sort((a, b) => Number(b.valor_pago || 0) - Number(a.valor_pago || 0));
  const maior = Number(ordenadas[0].valor_pago || 0);
  const menor = Number(ordenadas[ordenadas.length - 1].valor_pago || 0);
  if (maior === menor) return null; // valores iguais -> não sugere nada
  return ordenadas[ordenadas.length - 1].pagamento_id ?? ordenadas[ordenadas.length - 1].id ?? null;
}

/** Motivo é obrigatório para registrar qualquer decisão de triagem. */
export function decisaoValida({ decisao, motivo, pagamentoManterId, pagamentoDuplicadoId }) {
  if (!DECISOES_PERMITIDAS.includes(decisao)) return false;
  if (!motivo || !String(motivo).trim()) return false;
  if (decisao === STATUS_SUSPEITA.DUPLICIDADE) {
    if (!pagamentoManterId || !pagamentoDuplicadoId) return false;
    if (pagamentoManterId === pagamentoDuplicadoId) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Regra PERMANENTE de detecção (espelha o trigger AFTER INSERT em pagamentos).
// Mantida pura para poder testar o comportamento sem banco.
// ---------------------------------------------------------------------------

export const ACAO_DETECCAO = {
  IGNORAR: "IGNORAR",   // não há repetição objetiva (ou linha inválida / não é inserção nova)
  CRIAR: "CRIAR",       // primeira análise -> PENDENTE_VALIDACAO
  ANEXAR: "ANEXAR",     // grupo já existe e continua no mesmo status
  REABRIR: "REABRIR",   // grupo decidido + linha nova não analisada -> volta a PENDENTE
};

/**
 * Só avaliamos inserções OBJETIVAS e reais.
 * - ehInsercaoNova=false representa a reimportação da mesma linha (ON CONFLICT
 *   DO UPDATE no importador), que não dispara AFTER INSERT -> não gera grupo.
 */
export function deveAvaliarDeteccao(pagamento, ehInsercaoNova = true) {
  if (!ehInsercaoNova) return false;
  if (!pagamento) return false;
  if (!pagamento.numero_parcela_completo) return false; // só referência bancária
  if (pagamento.retroativo === true) return false;
  if (Number(pagamento.valor_pago || 0) <= 0) return false;
  if (pagamento.estornado) return false;
  return true;
}

/**
 * Decide a ação sobre o grupo após a inserção de uma linha objetiva.
 *
 * @param {null|{status:string, pagamentos_analisados?:string[]}} grupo grupo atual (ou null)
 * @param {{qtdObjetivaComChave:number, novoPagamentoId:string}} ctx
 * @returns {{acao:string, status:string}}
 */
export function avaliarDeteccaoSuspeita(grupo, { qtdObjetivaComChave, novoPagamentoId }) {
  // Precisa haver a MESMA referência em 2+ pagamentos objetivos.
  if (Number(qtdObjetivaComChave || 0) < 2) {
    return { acao: ACAO_DETECCAO.IGNORAR, status: grupo?.status ?? null };
  }
  if (!grupo) {
    return { acao: ACAO_DETECCAO.CRIAR, status: STATUS_SUSPEITA.PENDENTE };
  }
  if (grupo.status === STATUS_SUSPEITA.PENDENTE) {
    return { acao: ACAO_DETECCAO.ANEXAR, status: STATUS_SUSPEITA.PENDENTE };
  }
  // Grupo já decidido (LEGITIMO ou DUPLICIDADE_CONFIRMADA).
  const analisados = grupo.pagamentos_analisados || [];
  const jaAnalisado = analisados.includes(novoPagamentoId);
  if (jaAnalisado) {
    // Nenhuma linha nova -> não reabre, mantém a decisão.
    return { acao: ACAO_DETECCAO.ANEXAR, status: grupo.status };
  }
  // Terceiro pagamento (novo) para a referência -> reabre para validação.
  return { acao: ACAO_DETECCAO.REABRIR, status: STATUS_SUSPEITA.PENDENTE };
}

export function rotuloStatusSuspeita(status) {
  if (status === STATUS_SUSPEITA.LEGITIMO) return "Pagamento legítimo";
  if (status === STATUS_SUSPEITA.DUPLICIDADE) return "Duplicidade confirmada";
  return "Pendente de validação";
}

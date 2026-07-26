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

export function rotuloStatusSuspeita(status) {
  if (status === STATUS_SUSPEITA.LEGITIMO) return "Pagamento legítimo";
  if (status === STATUS_SUSPEITA.DUPLICIDADE) return "Duplicidade confirmada";
  return "Pendente de validação";
}

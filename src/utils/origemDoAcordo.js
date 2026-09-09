// DE ONDE UM ACORDO VEIO — a regra, separada da tela para poder ser testada.
//
// São TRÊS estados diferentes, e confundi-los é o erro que esta regra evita:
//
//   1. veio de MENSALIDADE — o acordo substituiu títulos de mensalidade;
//   2. RENEGOCIAÇÃO — o título de origem é o boleto de um acordo anterior
//      (`tipo_boleto = 'Acordo'`). Acontece muito: em 09/09/2026 eram 276
//      acordos ativos renegociando outro acordo;
//   3. SEM ORIGEM — o acordo chegou por importação sem dizer o que substituiu.
//      1.319 acordos ativos nessa situação, R$ 5,42 milhões.
//
// POR QUE NÃO USAR `parcelas.titulos_origem`: o gatilho que preenche esse campo
// FILTRA os títulos do tipo 'Acordo'. Renegociação (o caso 2) chegaria vazia e
// seria lida como caso 3 — 237 acordos e R$ 962 mil apareceriam como cegos sem
// ser. Por isso lemos os títulos direto.
//
// Um mesmo acordo pode ter os dois: parte mensalidade, parte renegociação.

const TIPO_ACORDO = "Acordo";

// Valor de um título de origem: o original é o que foi negociado. Saldo
// corrigido e em aberto mudam depois do acordo e diriam outra coisa.
function valorDoTitulo(t) {
  const v = Number(t?.valor_original ?? t?.saldo_corrigido ?? t?.valor_em_aberto ?? 0);
  return Number.isFinite(v) ? v : 0;
}

export function origemDoAcordo(titulos, acordoId) {
  const doAcordo = (titulos || [])
    .filter((t) => t && t.acordo_id === acordoId)
    .filter((t) => t.documento != null && String(t.documento).trim() !== "");

  const separar = (deAcordo) =>
    doAcordo
      .filter((t) => ((t.tipo_boleto || "") === TIPO_ACORDO) === deAcordo)
      // Do mais antigo para o mais novo: é a ordem em que a dívida se formou.
      .sort((a, b) => String(a.vencimento || "").localeCompare(String(b.vencimento || "")))
      .map((t) => ({
        documento: String(t.documento),
        vencimento: t.vencimento || null,
        valor: valorDoTitulo(t),
        situacao: t.situacao || null,
      }));

  const itensMensalidade = separar(false);
  const itensRenegociacao = separar(true);
  const somar = (itens) => itens.reduce((s, t) => s + t.valor, 0);

  return {
    // Detalhe: o que compõe o acordo, para a tela poder listar.
    itensMensalidade,
    itensRenegociacao,
    totalMensalidade: somar(itensMensalidade),
    totalRenegociacao: somar(itensRenegociacao),
    // Só os números, para a linha resumida.
    mensalidades: itensMensalidade.map((t) => t.documento),
    renegociacoes: itensRenegociacao.map((t) => t.documento),
    // "Sem origem" é a ausência das duas — e é informação, não vazio de tela.
    semOrigem: itensMensalidade.length === 0 && itensRenegociacao.length === 0,
  };
}

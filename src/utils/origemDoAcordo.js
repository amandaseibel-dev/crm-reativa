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
//
// ACORDO CANCELADO. Quando o acordo é cancelado, a dívida volta a ser cobrada e
// `acordos_titulos.acordo_id` é zerado — de propósito, é assim que a mensalidade
// reaparece na carteira. Só que a composição do acordo sumia junto, e é
// justamente aí que alguém precisa ver o que ele tinha dentro. Por isso, além
// do `acordo_id`, aceitamos o HISTÓRICO de `acordo_titulo_vinculo`: a linha do
// vínculo continua lá depois do cancelamento. O item volta marcado com
// `voltouACobrar`, para a tela poder dizer que aquela mensalidade está de volta.

const TIPO_ACORDO = "Acordo";

// Valor de um título de origem: o original é o que foi negociado. Saldo
// corrigido e em aberto mudam depois do acordo e diriam outra coisa.
function valorDoTitulo(t) {
  const v = Number(t?.valor_original ?? t?.saldo_corrigido ?? t?.valor_em_aberto ?? 0);
  return Number.isFinite(v) ? v : 0;
}

export function origemDoAcordo(titulos, acordoId, vinculos) {
  // Títulos que o histórico diz que passaram por este acordo, mesmo que hoje
  // não apontem mais para ele.
  const peloHistorico = new Set(
    (vinculos || [])
      .filter((v) => v && v.acordo_id === acordoId && v.titulo_id != null)
      .map((v) => String(v.titulo_id)),
  );

  const doAcordo = (titulos || [])
    .filter((t) => t && (t.acordo_id === acordoId || peloHistorico.has(String(t.id))))
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
        // Só o histórico liga este título ao acordo: o acordo caiu e a
        // mensalidade voltou para a carteira.
        voltouACobrar: t.acordo_id !== acordoId,
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

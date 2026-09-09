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

export function origemDoAcordo(titulos, acordoId) {
  const doAcordo = (titulos || []).filter((t) => t && t.acordo_id === acordoId);

  const documentosDe = (deAcordo) =>
    doAcordo
      .filter((t) => ((t.tipo_boleto || "") === TIPO_ACORDO) === deAcordo)
      .map((t) => t.documento)
      .filter((d) => d != null && String(d).trim() !== "")
      .map(String);

  const mensalidades = documentosDe(false);
  const renegociacoes = documentosDe(true);

  return {
    mensalidades,
    renegociacoes,
    // "Sem origem" é a ausência das duas — e é informação, não vazio de tela.
    semOrigem: mensalidades.length === 0 && renegociacoes.length === 0,
  };
}

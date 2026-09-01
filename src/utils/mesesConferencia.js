// Periodo. A LISTA NASCE DA DATA DE HOJE -- antes era escrita a mao ("Julho e
// agosto", "So julho"...) e o mes novo simplesmente nao existia na tela. Em
// 01/09/2026 entraram 62 pagamentos e R$ 36.307,38 que so apareciam em "Tudo":
// nenhum botao de periodo cobria setembro.
//
// `ate` e INCLUSIVO. Desde 31/08 a funcao compara `data_pagamento < p_ate + 1`,
// mas a lista antiga ainda usava limite exclusivo -- agosto ia ate "2026-09-01",
// entao "So agosto" trazia junto o dia 1o de setembro. Aqui `ate` e sempre o
// ULTIMO DIA do mes, e o rotulo passa a dizer a verdade.
//
// Junho continua sendo o comeco: antes disso nao ha extrato importado.
const PRIMEIRO_MES = { ano: 2026, mes: 6 };

const NOMES_MES = [
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
const ROTULO_MES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const doisDigitos = (n) => String(n).padStart(2, "0");
const primeiroDia = (ano, mes) => `${ano}-${doisDigitos(mes)}-01`;
// Dia 0 do mes seguinte = ultimo dia deste mes (cobre fevereiro e ano bissexto).
const ultimoDia = (ano, mes) => {
  const d = new Date(Date.UTC(ano, mes, 0));
  return `${d.getUTCFullYear()}-${doisDigitos(d.getUTCMonth() + 1)}-${doisDigitos(d.getUTCDate())}`;
};

/**
 * Botoes de periodo, do mes corrente para tras ate junho/2026.
 *
 * O primeiro botao (padrao) e "mes anterior + mes corrente": e o recorte que a
 * gestao usava como "Julho e agosto", agora andando sozinho com o calendario.
 * Exportada para poder ser testada sem montar a tela.
 */
export function listarMeses(hoje = new Date()) {
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth() + 1; // 1..12
  const antes = mes === 1 ? { ano: ano - 1, mes: 12 } : { ano, mes: mes - 1 };
  const temAnterior =
    antes.ano > PRIMEIRO_MES.ano ||
    (antes.ano === PRIMEIRO_MES.ano && antes.mes >= PRIMEIRO_MES.mes);

  const lista = [];
  if (temAnterior) {
    lista.push({
      chave: "RECENTE",
      rotulo: `${ROTULO_MES[antes.mes - 1]} e ${NOMES_MES[mes - 1]}`,
      de: primeiroDia(antes.ano, antes.mes),
      ate: ultimoDia(ano, mes),
    });
  }

  let a = ano;
  let m = mes;
  while (a > PRIMEIRO_MES.ano || (a === PRIMEIRO_MES.ano && m >= PRIMEIRO_MES.mes)) {
    lista.push({
      chave: `${a}-${doisDigitos(m)}`,
      rotulo: a === ano ? ROTULO_MES[m - 1] : `${ROTULO_MES[m - 1]}/${a}`,
      de: primeiroDia(a, m),
      ate: ultimoDia(a, m),
    });
    m -= 1;
    if (m === 0) { m = 12; a -= 1; }
  }

  lista.push({ chave: "TUDO", rotulo: "Tudo", de: null, ate: null });
  return lista;
}



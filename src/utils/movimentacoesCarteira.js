// --- Movimentacoes da carteira: um filtro, dois conjuntos -------------------
//
// O indicador "pendente de 1o acionamento" precisa de duas coisas da mesma
// tabela: as TABULACOES do responsavel atual e as TRANSFERENCIAS que provam
// quando o caso passou para a mao dele. Eram duas consultas identicas no
// alcance e diferentes so no predicado -- agora e uma, e estas duas funcoes
// montam o filtro e desfazem a juncao. Sao puras, para o teste poder cobrir a
// equivalencia sem subir banco.
//
// Moram aqui, e nao em PainelCarteira.jsx, porque um arquivo de componente que
// exporta funcao solta quebra o fast refresh do React (regra
// `react-refresh/only-export-components`). O conteudo e o mesmo, byte a byte.

// Valor para a lista `in.()` do PostgREST. Aspas duplas porque e-mail tem `.`
// e `@`, e sem elas a lista quebra em caso de valor com virgula.
function valorPostgrest(valor) {
  return '"' + String(valor).replace(/"/g, "") + '"';
}

/**
 * Filtro `.or()` que cobre, numa consulta, o que antes eram duas.
 *
 * @param {string[]} emails e-mails dos responsaveis desta carteira
 * @param {string[]} tipos tipos que contam como acionamento
 * @returns {string} filtro no formato do PostgREST
 */
export function filtroMovimentacoesCarteira(emails, tipos) {
  const listaEmails = (emails || []).map(valorPostgrest).join(",");
  const listaTipos = (tipos || []).map(valorPostgrest).join(",");
  return (
    `and(tipo.in.(${listaTipos}),registrado_por_email.in.(${listaEmails})),` +
    `operador_novo_email.in.(${listaEmails})`
  );
}

/**
 * Reparte as linhas da consulta unica nos dois conjuntos de antes.
 *
 * Aplica em JS exatamente o predicado que cada consulta aplicava no banco --
 * nada mais larga, nada mais estreita.
 *
 * COMPARACAO EXATA, de proposito. `.in()` do PostgREST vira `= ANY` no
 * Postgres, que diferencia maiuscula. Normalizar aqui deixaria passar para
 * `transferencias` uma linha que a consulta antiga NAO trazia (e-mail com
 * caixa diferente da lista), e o indicador mudaria de valor sem ninguem
 * pedir. Quem quiser tolerar caixa muda o predicado, nao a reparticao.
 *
 * @param {object[]} linhas resultado da consulta unificada
 * @param {string[]} emails e-mails dos responsaveis desta carteira
 * @param {string[]} tipos tipos que contam como acionamento
 * @returns {{tabulacoes: object[], transferencias: object[]}}
 */
export function separarMovimentacoesCarteira(linhas, emails, tipos) {
  const alvos = new Set(emails || []);
  const tiposAlvo = new Set(tipos || []);
  const tabulacoes = [];
  const transferencias = [];
  for (const linha of linhas || []) {
    if (tiposAlvo.has(linha?.tipo) && alvos.has(linha?.registrado_por_email)) {
      tabulacoes.push(linha);
    }
    if (alvos.has(linha?.operador_novo_email)) transferencias.push(linha);
  }
  return { tabulacoes, transferencias };
}

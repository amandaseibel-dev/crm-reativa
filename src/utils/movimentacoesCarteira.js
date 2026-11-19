// --- Movimentacoes da carteira: um filtro, dois conjuntos -------------------
//
// O indicador "pendente de 1o acionamento" precisa de duas coisas da mesma
// tabela: as TABULACOES do responsavel atual e as TRANSFERENCIAS que provam
// quando o caso passou para a mao dele. Eram duas consultas identicas no
// alcance e diferentes so no predicado -- agora e uma.
//
// O filtro e EXATO no servidor: so chegam ao navegador as linhas que a carteira
// usa. Nao ha linha de outro operador que nao seja tabulacao ou transferencia
// de um responsavel desta carteira.
//
//   or=(and(tipo.in.(T), registrado_por_email.in.(E)), operador_novo_email.in.(E))
//
// Sintaxe: `and(...)` aninhado dentro de `or(...)`, que e a forma documentada
// do PostgREST. Ainda nao ha outro ponto do CRM que use esse aninhamento em
// producao: ver a pendencia registrada na PR.

// Valor que pode entrar sem aspas numa lista `in.()` do PostgREST. Virgula,
// parenteses, aspas e espacos quebram a lista: recusamos em vez de adivinhar.
const VALOR_SEGURO = /^[^,()"\s]+$/;

function valoresSeguros(valores) {
  const limpos = (valores || []).map((v) => String(v || "").trim()).filter(Boolean);
  const invalidos = limpos.filter((v) => !VALOR_SEGURO.test(v));
  if (invalidos.length) {
    throw new Error(`valor nao aceito em filtro PostgREST: ${invalidos[0]}`);
  }
  return limpos.join(",");
}

/**
 * Filtro `.or()` exato: tabulacoes dos responsaveis OU transferencias para eles.
 *
 * @param {string[]} emails e-mails dos responsaveis desta carteira
 * @param {string[]} tipos tipos que contam como acionamento
 * @returns {string} filtro no formato do PostgREST
 */
export function filtroMovimentacoesCarteira(emails, tipos) {
  return (
    `and(tipo.in.(${valoresSeguros(tipos)}),` +
    `registrado_por_email.in.(${valoresSeguros(emails)})),` +
    `operador_novo_email.in.(${valoresSeguros(emails)})`
  );
}

/**
 * Reparte as linhas da consulta unica nos dois conjuntos de antes.
 *
 * Com o filtro exato, cada linha ja e de um dos dois lados; a reparticao so
 * confere de qual lado ela e. Comparacao exata, como o `= ANY` do banco.
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

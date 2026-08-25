// Busca paginada para furar o teto da API.
//
// A API devolve no MAXIMO 1000 linhas por requisicao -- inclusive quando a
// consulta nao pede limite nenhum -- e responde 206 (Partial Content), que e
// um codigo de SUCESSO. Ou seja: a tela recebe menos do que existe, nenhuma
// linha de erro aparece, nenhum log acusa, e o numero errado e exibido com a
// mesma confianca de um numero certo.
//
// Medido em producao em 25/08/2026: `alunos?select=id` sem limite algum voltou
// `content-range: 0-999/17470`.
//
// Use assim -- a funcao recebe a faixa e devolve a query daquela pagina:
//
//   const linhas = await buscarTudo((de, ate) =>
//     supabase.from("casos").select("id,nome")
//       .eq("operador_base", email)
//       .order("criado_em", { ascending: false })
//       .order("id", { ascending: true })   // <- desempate: ver abaixo
//       .range(de, ate)
//   );
//
// SEMPRE inclua uma coluna unica (id) como ultimo criterio de ordenacao. Sem
// isso, linhas com o mesmo valor no criterio principal trocam de posicao entre
// uma requisicao e outra: a mesma linha vem duas vezes numa pagina e some da
// outra. O bug e silencioso e some quando voce vai procurar.
//
// Quando o que se quer e apenas a CONTAGEM, nao use isto: peca a contagem ao
// banco com `.select("id", { count: "exact", head: true })`, que nao traz linha
// nenhuma e nao esbarra no teto.

export const TETO_API = 1000;

// Limite de seguranca: nenhuma tela do CRM lista tanta coisa de uma vez, e um
// filtro escrito errado nao pode virar um laco infinito contra o banco.
export const MAXIMO_PADRAO = 100000;

/**
 * Busca todas as linhas da consulta, de mil em mil, ate acabar.
 *
 * @param {(de: number, ate: number) => PromiseLike<{data: any[]|null, error: any}>} montarQuery
 *        Recebe a faixa (inclusiva nas duas pontas) e devolve a query da pagina.
 * @param {{pagina?: number, maximo?: number}} [opcoes]
 * @returns {Promise<any[]>} todas as linhas, na ordem em que vieram.
 * @throws o erro do banco, na primeira pagina que falhar (nada de devolver
 *         resultado parcial em silencio -- e exatamente o que queremos evitar).
 */
export async function buscarTudo(montarQuery, opcoes = {}) {
  const pagina = opcoes.pagina || TETO_API;
  const maximo = opcoes.maximo || MAXIMO_PADRAO;

  const todas = [];
  let de = 0;

  while (true) {
    const { data, error } = await montarQuery(de, de + pagina - 1);
    if (error) throw error;

    const lote = data || [];
    todas.push(...lote);

    // Pagina incompleta = acabou. E o unico criterio de parada confiavel:
    // count total pode vir nulo dependendo do Prefer usado na requisicao.
    if (lote.length < pagina) break;

    de += pagina;
    if (todas.length >= maximo) break;
  }

  return todas;
}

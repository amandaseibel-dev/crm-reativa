// Quando o rodape e o kanban podem mostrar contagens da lista como resultado de um
// recorte de curso ou semestre.
//
// Regra: com um recorte escolhido, a lista so e filtrada por um mapa VALIDADO para o
// escopo atual (operador e visao). Enquanto esse mapa nao existe -- carregando, falha,
// ou o escopo mudou e o mapa anterior nao vale mais --, a lista esta sem filtro e as
// contagens seriam o total geral. Nesse estado a tela mostra a mensagem, nao o numero.
//
// Sem recorte, a visualizacao normal sempre aparece.

export function recorteSemDadosValidados({ filtroCurso, filtroSemestre, carregando, mapaValido }) {
  const haRecorte = filtroCurso !== "TODOS" || filtroSemestre !== "AMBOS";
  if (!haRecorte) return false;
  return Boolean(carregando) || mapaValido === null || mapaValido === undefined;
}

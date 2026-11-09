// Votação do novo logotipo institucional ReATIVA.
//
// Configuração e textos puros, sem banco e sem React: fica separado para o teste
// cobrir a regra de exibição sem montar a tela.
//
// AS ARTES: as quatro propostas ainda não foram validadas. Enquanto `imagem` for
// null, a tela mostra um quadro de espera com o nome da marca, em vez de uma arte
// inventada. Quando as artes forem aprovadas, cada uma entra em
// src/assets/logotipo-votacao/ e o `imagem` recebe o import correspondente.

export const NOME_MARCA = "ReATIVA | Recuperação de Crédito";

export const OPCOES_LOGOTIPO = [
  { opcao: 1, titulo: "Proposta 1", imagem: null },
  { opcao: 2, titulo: "Proposta 2", imagem: null },
  { opcao: 3, titulo: "Proposta 3", imagem: null },
  { opcao: 4, titulo: "Proposta 4", imagem: null },
];

// Traduz o erro do banco (a mensagem da exceção é um código curto) em texto para
// o operador. Código desconhecido cai numa mensagem genérica, sem vazar detalhe.
const MENSAGENS = [
  ["ja_votou", "Você já registrou seu voto. Cada operador vota uma única vez."],
  ["votacao_encerrada", "A votação já foi encerrada."],
  ["ja_encerrada", "A votação já estava encerrada."],
  ["acesso_negado", "Seu acesso não permite esta ação. Procure a gestão."],
  ["resultado_indisponivel", "O resultado será liberado quando a votação for encerrada."],
  ["opcao_invalida", "Escolha uma das quatro propostas."],
  ["votacao_inexistente", "A votação ainda não está disponível."],
];

export function mensagemErroVotacao(erro) {
  const texto = String(erro?.message || erro || "");
  const achado = MENSAGENS.find(([codigo]) => texto.includes(codigo));
  return achado ? achado[1] : "Não foi possível concluir agora. Tente novamente em instantes.";
}

// Percentual de cada opção sobre o total, para as barras da gestão.
// Total zero devolve 0 em todas, sem divisão por zero.
export function percentuais(opcoes = [], total = 0) {
  return opcoes.map((o) => ({
    opcao: o.opcao,
    votos: o.votos,
    percentual: total > 0 ? Math.round((o.votos / total) * 100) : 0,
  }));
}

// QUANDO A CONFIRMAÇÃO PODE SER UM CLIQUE SÓ.
//
// A tela já traz nome, CPF, responsável, valor que entrou e data do extrato
// prontos na linha -- não há nada para digitar no caso comum. O que sobrava era
// o diálogo "Sim/Não" em cima de TODA linha, inclusive das 'normais', onde
// `conferencia_baixar_do_extrato` só registra um fato que já aconteceu no banco
// e `confirmar_baixa_caso` não zera nada porque ainda há saldo.
//
// Então o pedágio passa a ser cobrado onde ele realmente protege: na linha de
// exceção. É aqui que a lista de exceções vive -- fora do componente, para ser
// testável e para a tela e o teclado concordarem sobre o que é exceção.
//
// A mais importante é SALDO ZERADO: `confirmar_baixa_caso` quita o caso quando
// o saldo já está em zero. Confirmar com um clique ali seria quitação por
// mão errada -- e é justamente a proteção que a tela nunca pode perder.
export function excecoesDaLinha(l) {
  const linha = l || {};
  const entrou = Number(linha.entrou || 0);
  const baixado = Number(linha.baixado || 0);
  const saldo = Number(linha.saldo_aberto || 0);
  const fora = [];

  // IDENTIDADE PRIMEIRO. Sem dono, achar o dono vem antes de qualquer decisao
  // -- e nao ha o que somar a essa lista.
  if (linha.tipo === "SEM_VINCULO" || !linha.aluno_id) {
    fora.push({ chave: "SEM_VINCULO", texto: "pagamento sem v\u00ednculo: precisa achar o dono antes" });
    return fora;
  }
  // Vinculado mas sem CPF na ficha: o pagamento esta ligado a um cadastro que
  // nao tem a chave de identidade. Esta base ja pagou uma migration inteira de
  // fusao por cadastro repetido -- aqui se olha antes de registrar dinheiro.
  if (!String(linha.cpf || "").replace(/\D/g, "")) {
    fora.push({ chave: "SEM_CPF", texto: "o cadastro vinculado est\u00e1 sem CPF: confirme a identidade" });
  }
  if (saldo <= 0.005) {
    fora.push({ chave: "QUITARIA", texto: "sem saldo em aberto: confirmar aqui deixa o caso quitar" });
  }
  // A IDEMPOTENCIA DA BAIXA DEPENDE DA DATA. `conferencia_baixar_do_extrato` so
  // ignora baixa repetida quando aluno, data E valor batem. Com data nula, a
  // comparacao e NULL = NULL: nunca casa, e cada clique cria uma baixa nova.
  if (!linha.ultimo_pagamento) {
    fora.push({ chave: "SEM_DATA", texto: "sem data de pagamento: a trava contra baixa repetida n\u00e3o funciona" });
  }
  // A RPC recusa valor <= 0; melhor explicar aqui do que mostrar erro de banco.
  if (entrou <= 0.005 && baixado <= 0.005) {
    fora.push({ chave: "SEM_VALOR", texto: "nada entrou no extrato nesta janela" });
  }
  if (entrou <= 0.005 && baixado > 0.005) {
    fora.push({ chave: "SEM_LASTRO", texto: "baixa registrada sem pagamento correspondente no extrato" });
  }
  if (entrou > 0.005 && baixado > 0.005 && Math.abs(entrou - baixado) > 0.05) {
    fora.push({ chave: "DIVERGE", texto: "o valor baixado n\u00e3o \u00e9 o valor que entrou" });
  }
  // BAIXA JA EXISTENTE = RISCO DE BAIXA EM DOBRO, mesmo quando a soma bate.
  // `baixado` aqui e a SOMA das baixas da janela e `p_valor` e a SOMA dos
  // pagamentos: duas baixas de 250 em datas diferentes somam os 500 que
  // entraram, a soma "confere", e a trava da RPC -- que compara UMA baixa de
  // mesma data e mesmo valor -- nao casa com nenhuma delas. Um clique ali
  // criaria uma terceira baixa, de 500. Entao qualquer baixa previa na janela
  // tira a linha do clique unico, divergente ou nao.
  if (entrou > 0.005 && baixado > 0.005 && Math.abs(entrou - baixado) <= 0.05) {
    fora.push({ chave: "JA_TEM_BAIXA", texto: "j\u00e1 existe baixa nesta janela: confira antes de registrar outra" });
  }
  if (linha.quitado_em && linha.ultimo_pagamento && linha.ultimo_pagamento > linha.quitado_em) {
    fora.push({ chave: "DEPOIS_DE_QUITAR", texto: "o pagamento entrou depois da quita\u00e7\u00e3o" });
  }
  if (Number(linha.em_confirmacao || 0) > 0.005) {
    fora.push({ chave: "EM_CONFIRMACAO", texto: "mensalidade em confirma\u00e7\u00e3o ainda esperando decis\u00e3o" });
  }
  return fora;
}

// Linha normal: um clique confirma. Linha de exceção: abre a análise.
export function ehExcecao(l) {
  return excecoesDaLinha(l).length > 0;
}

// Motivos prontos do "Já tratado". Existiam só na cabeça de quem digitava --
// e o campo exige 3 caracteres, então toda saída lateral custava uma frase.
export const MOTIVOS_JA_TRATADO = [
  "Cartão baixado no Prime",
  "Baixa feita na ficha do aluno",
  "Acordo já quitado por fora",
];

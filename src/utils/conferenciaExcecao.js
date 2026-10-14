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

  if (linha.tipo === "SEM_VINCULO" || !linha.aluno_id) {
    fora.push({ chave: "SEM_VINCULO", texto: "pagamento sem vínculo: precisa achar o dono antes" });
    return fora;
  }
  if (saldo <= 0.005) {
    fora.push({ chave: "QUITARIA", texto: "sem saldo em aberto: confirmar aqui deixa o caso quitar" });
  }
  if (entrou <= 0.005 && baixado > 0.005) {
    fora.push({ chave: "SEM_LASTRO", texto: "baixa registrada sem pagamento correspondente no extrato" });
  }
  if (entrou > 0.005 && baixado > 0.005 && Math.abs(entrou - baixado) > 0.05) {
    fora.push({ chave: "DIVERGE", texto: "o valor baixado não é o valor que entrou" });
  }
  if (linha.quitado_em && linha.ultimo_pagamento && linha.ultimo_pagamento > linha.quitado_em) {
    fora.push({ chave: "DEPOIS_DE_QUITAR", texto: "o pagamento entrou depois da quitação" });
  }
  if (Number(linha.em_confirmacao || 0) > 0.005) {
    fora.push({ chave: "EM_CONFIRMACAO", texto: "mensalidade em confirmação ainda esperando decisão" });
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

// A REGRA DO TITULO "EM CONFIRMACAO", EM UM LUGAR SO.
//
// Mora aqui, e nao dentro da tela, porque duas telas mostram o mesmo caso -- a
// fila do extrato (Confirmacao de Pagamento) e a ficha do aluno -- e a sexta
// copia de uma regra financeira em JavaScript e exatamente o que ja fez o
// catalogo de tabulacoes parar de governar o select.
//
// O efeito de cada clique NAO e decidido aqui: quem decide e
// `conferencia_em_confirmacao_do_aluno`, que le as mesmas funcoes que vao
// executar. Esta lista diz apenas quais efeitos podem virar botao.

// `prime_conferencia_vincular` recusa acordo cancelado e acordo quitado sem
// dinheiro real. Oferecer o botao nesses casos seria prometer o que o backend
// nega na cara da pessoa.
export const EFEITO_VINCULA = new Set(["VIRA_PAGO", "VIRA_NEGOCIADO"]);

// Motivo escrito e obrigatorio: as RPCs recusam abaixo de 10 caracteres, entao
// pedimos antes de gastar a ida ao banco -- e o texto e o que fica na
// auditoria, junto de quem decidiu.
export const MINIMO_MOTIVO = 10;

export function pedirMotivo(pergunta, minimo = MINIMO_MOTIVO) {
  const t = window.prompt(pergunta);
  if (t === null) return null;
  const limpo = String(t).trim();
  if (limpo.length < minimo) {
    alert(`Escreva o motivo com pelo menos ${minimo} caracteres — é ele que fica na auditoria.`);
    return null;
  }
  return limpo;
}

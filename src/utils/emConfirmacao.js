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

export function pedirMotivo(pergunta, minimo = MINIMO_MOTIVO, sugestao = "") {
  const t = window.prompt(pergunta, sugestao);
  if (t === null) return null;
  const limpo = String(t).trim();
  if (limpo.length < minimo) {
    alert(`Escreva o motivo com pelo menos ${minimo} caracteres — é ele que fica na auditoria.`);
    return null;
  }
  return limpo;
}

// O MOTIVO JA VEM ESCRITO.
//
// Amanda, 24/09/2026: "ainda tenho que colocar o motivo com 10 caracteres?".
// Sim -- a recusa e do banco (`prime_conferencia_vincular` exige acordo
// escolhido E motivo quando o subgrupo nao e um dos tres comprovados), nao da
// tela. Mas exigir que ela SEJA DIGITADA nao acrescenta nada: o que a auditoria
// precisa e de qual acordo foi escolhido, por qual titulo e com que valores --
// e isso o sistema ja sabe. Entao o texto vem pronto no prompt e ela so
// confirma; se quiser trocar, e so escrever por cima.
//
// Escrever o VALOR dos dois lados e de proposito: e a conferencia que faltava
// em todas as rotas de vinculo. Foi por nao comparar valor que o vinculo
// automatico prendeu R$ 64.362,00 num acordo de R$ 15.428,65 (pausado em
// 24/09), e que a sugestao do boleto 4445066 (R$ 3.987,54) aponta para um
// acordo de R$ 981,08. Com os dois numeros no texto, a diferenca salta antes
// do Enter.
export function motivoSugerido(item, acordo) {
  const dinheiro = (v) =>
    Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const numero = acordo?.numero || item?.acordo_numero || "?";
  const status = acordo?.status ? `, ${String(acordo.status).toLowerCase()}` : "";
  const valorAcordo = acordo?.valor_total != null ? ` (${dinheiro(acordo.valor_total)}${status})` : "";
  return (
    `acordo ${numero}${valorAcordo} escolhido pela gestão para o boleto ` +
    `${item?.documento || "?"} (${dinheiro(item?.valor)})`
  );
}

// AS CLASSES DO "O QUE APARECEU NO PRIME".
//
// Copiadas de `prime_conferencia_classificar_humano`, que recusa qualquer outro
// valor com CLASSE_INVALIDA. A lista existe aqui para a tela montar o select;
// quem valida continua sendo o banco.
export const CLASSES_HUMANAS = [
  { valor: "PAGAMENTO_REAL", rotulo: "Pagamento real" },
  { valor: "ACORDO", rotulo: "Acordo" },
  { valor: "LIQUIDACAO_INSTITUCIONAL", rotulo: "Liquidação institucional" },
  { valor: "CANCELAMENTO_ESTORNO", rotulo: "Cancelamento / estorno" },
  { valor: "ISENCAO_FIES_BOLSA", rotulo: "Isenção, FIES ou bolsa" },
  { valor: "SUBSTITUICAO_TITULO", rotulo: "Substituição de título" },
  { valor: "INCONCLUSIVO", rotulo: "Inconclusivo" },
];

// AS DUAS QUE ENCERRAM ADMINISTRATIVAMENTE.
//
// `prime_conferencia_encerrar_administrativo` recusa qualquer outra com
// CLASSE_NAO_ADMINISTRATIVA. Oferecer o botao fora destas duas seria prometer o
// que o backend nega -- o mesmo motivo pelo qual EFEITO_VINCULA existe.
export const CLASSES_ADMINISTRATIVAS = new Set(["CANCELAMENTO_ESTORNO", "ISENCAO_FIES_BOLSA"]);

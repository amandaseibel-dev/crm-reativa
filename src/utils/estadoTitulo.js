// O ESTADO DE UMA MENSALIDADE, EM UM LUGAR SO.
//
// A ficha decidia rotulo e "entra no total" com uma cadeia de ternarios inline,
// e cada um deles era uma copia da regra. Foi assim que CANCELADA passou a
// aparecer como "Em aberto" (349 titulos, R$ 2.477.168,16) e que DUPLICADA
// exibia "Fora da conta" enquanto entrava na contagem de mensalidades abertas.
//
// A REGUA E A FONTE CANONICA, nao esta funcao: `aluno_saldo_pendente_detalhe`
// conta como divida apenas `situacao in ('ABERTO','NEGOCIADO')`, e o valor
// exibido na ficha vem DELA. O que mora aqui e o espelho dessa regra para o que
// o React ainda precisa decidir sozinho -- qual etiqueta mostrar e quantas
// mensalidades estao abertas -- para que esse espelho seja um so, e testavel.
//
// Conferido em 23/09/2026 contra: aluno_saldo_pendente_detalhe,
// recalcular_situacao_aluno, acoes_massivas_universo,
// buscar_candidatos_acoes_massivas e titulos_disponiveis_para_acordo. As cinco
// concordam: CANCELADA e DUPLICADA ficam fora de saldo, fila e acordo.

export const ESTADO = Object.freeze({
  PAGO: "PAGO",
  DUPLICADA: "DUPLICADA",
  CANCELADA: "CANCELADA",
  EM_CONFIRMACAO: "EM_CONFIRMACAO",
  NEGOCIADO: "NEGOCIADO",
  ABERTO: "ABERTO",
});

const ROTULO = Object.freeze({
  PAGO: "Quitada",
  DUPLICADA: "Fora da conta",
  CANCELADA: "Cancelada",
  EM_CONFIRMACAO: "Em confirmação",
  NEGOCIADO: "Negociado",
  ABERTO: "Em aberto",
});

const sit = (t) => String(t?.situacao || "").toUpperCase();
const st = (t) => String(t?.status || "").toLowerCase();

// A ORDEM E A REGRA. Terminal primeiro (uma mensalidade paga continua paga,
// mesmo com acordo_id), depois o que saiu da conta, depois o que espera
// decisao, e so entao negociado/aberto. Inverter a ordem e como o cancelado
// virava "Em aberto": ele caia no fim da cadeia sem nunca ter sido testado.
export function estadoDoTitulo(t) {
  if (sit(t) === "PAGO" || st(t) === "quitada") return ESTADO.PAGO;
  if (sit(t) === "DUPLICADA") return ESTADO.DUPLICADA;
  if (sit(t) === "CANCELADA" || st(t) === "cancelada") return ESTADO.CANCELADA;
  if (sit(t) === "EM_CONFIRMACAO") return ESTADO.EM_CONFIRMACAO;
  if (st(t) === "vinculada" || sit(t) === "NEGOCIADO" || !!t?.acordo_id) return ESTADO.NEGOCIADO;
  return ESTADO.ABERTO;
}

export function rotuloDoTitulo(t) {
  return ROTULO[estadoDoTitulo(t)];
}

// Entra na CONTAGEM de "mensalidades em aberto" da ficha. O VALOR exibido ao
// lado nao passa por aqui: ele vem de `aluno_saldo_pendente_detalhe`. Esta
// funcao existe para a contagem dizer a mesma coisa que o valor.
export function contaComoAberta(t) {
  return estadoDoTitulo(t) === ESTADO.ABERTO;
}

// Estados que saem da cobranca e, por isso, precisam de um caminho de saida
// explicito na tela -- senao o titulo fica preso sem ninguem saber onde mexer.
export const PRECISA_DE_SAIDA = Object.freeze([ESTADO.EM_CONFIRMACAO, ESTADO.DUPLICADA]);

export function precisaDeSaida(t) {
  return PRECISA_DE_SAIDA.includes(estadoDoTitulo(t));
}

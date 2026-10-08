// STATUS DE PARCELA -- espelho de `public.parcela_viva()` no front.
//
// POR QUE EXISTE. A decisão "esta parcela ainda é cobrável" estava escrita como
// comparação solta -- `p.status !== "PAGO" && p.status !== "CANCELADA"` -- em 8
// pontos de 4 arquivos. Era o mesmo problema que o banco tinha em 57 pontos: a
// regra da gestão de 07/10/2026 criou dois status novos (DEVOLVIDA e SUSPENSA)
// e, em cada um desses pontos, status novo que não esteja na comparação é lido
// como ABERTO -- a parcela sai do saldo no banco e continua somando na tela.
//
// A REGRA, QUE É A MESMA DO BANCO:
//   PAGO/PAGA .................. pagamento real (regra 1: só aqui entra dinheiro)
//   CANCELADA/CANCELADO ........ saída por cancelamento
//   ESTORNADA/ESTORNADO ........ saída por estorno
//   DEVOLVIDA .................. saiu definitivamente da nossa responsabilidade,
//                                sem pagamento (regra 2)
//   SUSPENSA ................... cobrança suspensa temporariamente, sem
//                                pagamento (regra 3)
//   qualquer outro ............. COBRÁVEL
//
// FALHA PARA O LADO SEGURO, igual ao banco: status desconhecido conta como
// cobrável. Erra mostrando dívida que não deveria estar lá -- que alguém vê e
// reclama -- em vez de sumir com dívida em silêncio.
//
// NÃO inclui RENEGOCIADA, pela mesma razão do banco: são 6 parcelas reais em
// produção e a classificação delas divergia entre os pontos do sistema. Mudar
// isso é decisão de negócio separada, não efeito colateral desta regra.

const FORA_DO_COBRAVEL = new Set([
  "PAGO",
  "PAGA",
  "CANCELADA",
  "CANCELADO",
  "ESTORNADA",
  "ESTORNADO",
  "DEVOLVIDA",
  "SUSPENSA",
]);

/** true quando a parcela ainda é cobrável. Espelha `public.parcela_viva()`. */
export function parcelaViva(status) {
  return !FORA_DO_COBRAVEL.has(String(status ?? "").trim().toUpperCase());
}

/** true quando a parcela saiu do cobrável SEM pagamento (devolvida ou suspensa). */
export function parcelaSemPagamento(status) {
  const s = String(status ?? "").trim().toUpperCase();
  return s === "DEVOLVIDA" || s === "SUSPENSA";
}

/** true só quando houve pagamento real. */
export function parcelaPaga(status) {
  const s = String(status ?? "").trim().toUpperCase();
  return s === "PAGO" || s === "PAGA";
}

const ROTULOS = {
  A_VENCER: "A vencer",
  VENCIDA: "Vencida",
  PAGO: "Paga",
  PAGA: "Paga",
  CANCELADA: "Cancelada",
  CANCELADO: "Cancelada",
  ESTORNADA: "Estornada",
  ESTORNADO: "Estornada",
  RENEGOCIADA: "Renegociada",
  // Os dois rótulos novos dizem que NÃO houve pagamento -- é o ponto todo da
  // regra. "Devolvida" nunca pode aparecer como "Paga" na tela.
  DEVOLVIDA: "Devolvida (sem pagamento)",
  SUSPENSA: "Suspensa (sem pagamento)",
};

export function rotuloParcela(status) {
  const s = String(status ?? "").trim().toUpperCase();
  return ROTULOS[s] || status || "";
}

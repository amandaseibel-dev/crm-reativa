// AJUSTE DE VALOR COBRAVEL -- a regra em um lugar so.
//
// POR QUE ESTE ARQUIVO EXISTE. O valor do bordero e historico e nunca muda. O
// que muda e o valor que a operacao cobra. Essa diferenca aparece em tres
// lugares da ficha (o total de mensalidades, a linha do titulo e o botao de
// ajustar) e precisa dar o mesmo numero nos tres -- e o mesmo numero que o
// backend calcula. Entao a formula mora aqui, e nao espalhada em cada tela.
//
// O BACKEND E A FONTE DE VERDADE. Estas funcoes existem para a tela desenhar e
// habilitar/desabilitar botao. Quem recusa de fato e
// `crm_usuario_pode_ajustar_valor()` e `titulo_ajuste_valor_bloqueio()` no
// banco, mais o gatilho `trg_titulo_ajuste_valor_protegido`. Esconder botao
// nunca foi protecao.

// Amanda (gerencia) e Fernanda (supervisor), como cadastradas no CRM.
// cobranca07@ e a Amanda Borges, do administrativo -- outra pessoa, fora desta
// permissao de proposito. Espelha exatamente a lista do backend.
export const EMAILS_AJUSTE_VALOR = [
  "amanda.seibel@aelbra.com.br",
  "cobranca04@aelbra.com.br",
];

export function podeAjustarValor(email) {
  return EMAILS_AJUSTE_VALOR.includes(String(email || "").trim().toLowerCase());
}

// O valor que o bordero registrou. Nunca muda.
export function valorOriginalTitulo(t) {
  return Number(t?.valor_original ?? 0);
}

// A regra que ja existia antes do ajuste, sem o ajuste.
export function valorBaseTitulo(t) {
  if (!t) return 0;
  const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  return n(t.saldo_corrigido) ?? n(t.valor_em_aberto) ?? n(t.valor_original) ?? 0;
}

export function temAjusteValor(t) {
  const v = t?.valor_cobranca_ajustado;
  return v !== null && v !== undefined && v !== "" && Number(v) > 0;
}

// O valor que a operacao cobra: o ajuste quando existir, senao a regra atual.
// Espelha `coalesce(valor_cobranca_ajustado, saldo_corrigido, valor_em_aberto,
// valor_original, 0)` dos tres leitores de backend.
export function valorOperacionalTitulo(t) {
  if (temAjusteValor(t)) return Number(t.valor_cobranca_ajustado);
  return valorBaseTitulo(t);
}

// Quanto o ajuste tirou (positivo) ou acrescentou (negativo) do saldo.
export function diferencaDoAjuste(t) {
  if (!temAjusteValor(t)) return 0;
  return Number((valorBaseTitulo(t) - Number(t.valor_cobranca_ajustado)).toFixed(2));
}

// Espelha `titulo_ajuste_valor_bloqueio` no banco. Devolve null quando o titulo
// aceita ajuste, ou o codigo do bloqueio -- os mesmos codigos do backend, para
// a tela poder explicar sem traduzir nada.
export function bloqueioAjusteValor(t) {
  if (!t) return "TITULO_NAO_ENCONTRADO";
  const situacao = String(t.situacao || "").toUpperCase();
  const status = String(t.status || "").toLowerCase();
  if (String(t.tipo_boleto || "") === "Acordo") return "TITULO_DE_ACORDO";
  if (situacao === "PAGO") return "TITULO_PAGO";
  if (situacao === "CANCELADA") return "TITULO_CANCELADO";
  if (situacao === "DUPLICADA") return "TITULO_DUPLICADO";
  if (situacao !== "ABERTO") return "TITULO_NAO_ABERTO";
  if (status !== "em_aberto") return "TITULO_NAO_COBRAVEL";
  if (t.acordo_id) return "TITULO_EM_ACORDO";
  if (valorBaseTitulo(t) <= 0) return "TITULO_SEM_VALOR";
  return null;
}

export const MOTIVO_BLOQUEIO = {
  TITULO_NAO_ENCONTRADO: "Título não encontrado.",
  TITULO_DE_ACORDO: "É o boleto do próprio acordo — a dívida são as parcelas dele.",
  TITULO_PAGO: "Título já pago.",
  TITULO_CANCELADO: "Título cancelado.",
  TITULO_DUPLICADO: "Título marcado como duplicado.",
  TITULO_NAO_ABERTO: "Título não está aberto.",
  TITULO_NAO_COBRAVEL: "Título não está cobrável.",
  TITULO_EM_ACORDO: "Título já está em um acordo.",
  TITULO_EM_ACORDO_VIVO: "Título já está em um acordo vivo.",
  TITULO_SEM_VALOR: "Título sem valor em aberto.",
  VALOR_DEVE_SER_MAIOR_QUE_ZERO: "O valor cobrável precisa ser maior que zero.",
  MOTIVO_OBRIGATORIO: "Informe o motivo do ajuste.",
  SEM_AJUSTE_PARA_REMOVER: "Este título não tem ajuste para remover.",
};

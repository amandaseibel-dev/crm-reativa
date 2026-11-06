// Apresentação da lista de movimentações do aluno.
//
// Só formata e classifica o que já veio do banco: não decide regra de negócio,
// não filtra registro e não altera o histórico. O corte de exibição é visual —
// a lista completa continua disponível para "Ver todas" e para o PDF.

export const LIMITE_MOVIMENTACOES_VISIVEIS = 10;

// Cores discretas por natureza do evento. A borda esquerda do card é o único
// sinal visual; o texto do tipo continua sendo a fonte da verdade para o
// operador. Chave é o trecho procurado no tipo/status, em maiúsculas.
const FAIXAS = [
  { chave: ["PAGAMENTO", "BAIXA_REALIZADA", "QUITA", "PAGO", "RECUPERA"], cor: "#16a34a" },
  { chave: ["CANCELA", "REJEIT", "ERRO", "FALHA", "EXCLU"], cor: "#dc2626" },
  { chave: ["AGUARDANDO", "PENDENTE", "CONFIRMACAO", "ENVIADO", "SOLICITA"], cor: "#d97706" },
  { chave: ["ACORDO", "NEGOCIA", "TERMO", "LINK"], cor: "#7c3aed" },
  { chave: ["SISTEMA", "AUTOMATICO", "IMPORTA", "CRON"], cor: "#64748b" },
];

const COR_PADRAO = "#2563eb";

/**
 * Cor da borda de um registro, a partir do tipo (com o status novo como
 * desempate). Sem correspondência, devolve o azul padrão que a tela já usava.
 */
export function corMovimentacao(tipo, statusNovo) {
  const alvo = `${tipo || ""} ${statusNovo || ""}`.toUpperCase();
  if (!alvo.trim()) return COR_PADRAO;
  for (const faixa of FAIXAS) {
    if (faixa.chave.some((k) => alvo.includes(k))) return faixa.cor;
  }
  return COR_PADRAO;
}

/**
 * Transição de status em uma linha só. Devolve string vazia quando não há
 * transição real — assim a linha some do card em vez de exibir "- → -".
 */
export function resumoStatus(statusAnterior, statusNovo) {
  const de = (statusAnterior || "").trim();
  const para = (statusNovo || "").trim();
  if (!de && !para) return "";
  if (!de) return para;
  if (!para) return de;
  if (de === para) return para;
  return `${de} → ${para}`;
}

/**
 * Rótulo do operador: só o nome. O e-mail — que é a chave do operador —
 * continua no dado e vai para o atributo `title`, não para a linha.
 */
export function rotuloOperador(nome, email) {
  const n = (nome || "").trim();
  if (n) return n;
  const e = (email || "").trim();
  return e || "";
}

/**
 * Recorte visual da lista. Nunca reordena nem descarta: devolve a fatia a
 * renderizar, quantos ficaram ocultos e se o botão de expandir faz sentido.
 */
export function recortarMovimentacoes(
  movimentacoes,
  expandido,
  limite = LIMITE_MOVIMENTACOES_VISIVEIS,
) {
  const lista = Array.isArray(movimentacoes) ? movimentacoes : [];
  const total = lista.length;
  const excede = total > limite;
  const visiveis = expandido || !excede ? lista : lista.slice(0, limite);
  return {
    visiveis,
    total,
    ocultas: total - visiveis.length,
    podeExpandir: excede,
  };
}

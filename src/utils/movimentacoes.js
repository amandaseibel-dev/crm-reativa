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

// --- Linha única ---------------------------------------------------------
//
// A ficha mostrava CADA movimentação em três linhas (tipo, descrição, meta),
// com o tipo repetindo o que a descrição já dizia e com nome de coluna do
// banco na cara do operador. O que segue reduz o registro a UMA linha, sem
// esconder registro nenhum: o que não cabe vai para o `title`, e o histórico
// completo continua no "Ver todas" e no PDF.

/**
 * Data compacta para a linha: "07/11 10:01". O ano fica de fora porque a
 * lista é cronológica e o ano inteiro está no `title`. Coluna `date` pura
 * (sem horário) não passa por `new Date` -- ver a mesma armadilha em
 * `formatarDataHora`: o parser leria como UTC e o dia voltaria um.
 */
export function dataCompacta(valor) {
  if (!valor) return "";
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
      const [, mes, dia] = valor.split("-");
      return `${dia}/${mes}`;
    }
    const d = new Date(valor);
    if (Number.isNaN(d.getTime())) return "";
    const dia = String(d.getDate()).padStart(2, "0");
    const mes = String(d.getMonth() + 1).padStart(2, "0");
    const hora = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${dia}/${mes} ${hora}:${min}`;
  } catch {
    return "";
  }
}

/**
 * Transição em português. `traduzir` é injetado (na tela, `rotuloStatus`)
 * para este módulo seguir sem depender de outro: quem chama decide o mapa.
 */
export function resumoStatusLegivel(statusAnterior, statusNovo, traduzir) {
  const t = typeof traduzir === "function" ? traduzir : (v) => v;
  const de = (statusAnterior || "").trim();
  const para = (statusNovo || "").trim();
  if (!de && !para) return "";
  if (!de) return t(para);
  if (!para) return t(de);
  if (de === para) return t(para);
  return `${t(de)} → ${t(para)}`;
}

/**
 * Os quatro pedaços da linha única. Nada é descartado: o que não entra em
 * `texto` entra em `titulo`, que a tela põe no atributo `title`.
 *
 * `texto` prefere a descrição porque é ela que diz o que houve; o tipo só
 * aparece quando não há descrição, e ainda assim traduzido.
 */
export function linhaMovimentacao(mov, traduzir, formatarCompleta) {
  const m = mov || {};
  const t = typeof traduzir === "function" ? traduzir : (v) => v;
  const transicao = resumoStatusLegivel(m.status_anterior, m.status_novo, t);
  const descricao = (m.descricao || "").trim();
  const tipoLegivel = m.tipo ? t(m.tipo) : "";
  const operador = rotuloOperador(m.registrado_por_nome, m.registrado_por_email);

  const texto = descricao || transicao || tipoLegivel || "Movimentação";

  const completa =
    typeof formatarCompleta === "function" ? formatarCompleta(m.registrado_em) : "";
  const partes = [
    tipoLegivel,
    completa,
    transicao,
    descricao,
    operador && m.registrado_por_email ? `${operador} (${m.registrado_por_email})` : operador,
  ].filter(Boolean);

  return {
    data: dataCompacta(m.registrado_em),
    texto,
    operador,
    titulo: partes.join("\n"),
  };
}

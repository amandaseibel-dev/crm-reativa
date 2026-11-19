// Aba Jurídico -- rótulos e montagem das linhas do Excel. Sem regra de negócio:
// quem decide elegibilidade, pendência e bloqueio é o banco (RPCs `juridico_*`).

export const STATUS_CASO = Object.freeze({
  EM_ANALISE: "Em análise",
  APROVADO: "Aprovado",
  ENVIADO_FINANCEIRO: "Enviado ao financeiro",
  CONFIRMADO_JURIDICO: "Encaminhado ao jurídico",
});

export const GRUPOS = Object.freeze([
  { chave: "FORMADO", rotulo: "Formados" },
  { chave: "TRANCADO", rotulo: "Trancados" },
  { chave: "EVADIDO", rotulo: "Evadidos" },
]);

const PENDENCIAS = {
  PAGAMENTO_PENDENTE: "Pagamento aguardando confirmação",
  SEM_SALDO_ELEGIVEL: "Sem saldo elegível",
  ACORDO_ATIVO_SEM_APROVACAO: "Acordo ativo: exige aprovação específica",
  ACORDO_REATIVADO_APOS_GERACAO: "Acordo da lista cancelado e reativado depois da revisão: exige nova revisão",
  ACORDO_QUEBRADO_SEM_REVISAO: "Acordo quebrado: exige revisão financeira antes da aprovação",
  ACORDO_NOVO_APOS_GERACAO: "Acordo ativo novo ou reativado depois da lista: exige revisão e aprovação específica",
  TERMO_NAO_LOCALIZADO: "Termo do acordo não localizado",
  TERMO_A_VALIDAR: "Termo localizado, mas precisa de validação",
  PAGAMENTO_NAO_BAIXADO: "Pagamento recebido e ainda não baixado",
};

const DIVERGENCIAS = {
  MENSALIDADE_ALTERADA: "Mensalidade mudou depois da aprovação",
  PARCELA_ALTERADA: "Parcela de acordo mudou depois da aprovação",
  PAGAMENTO_NAO_BAIXADO: "Pagamento recebido e não baixado",
  PAGAMENTO_AGUARDANDO_CONFIRMACAO: "Pagamento aguardando confirmação",
  ACORDO_NOVO: "Acordo novo, ou reativado depois da aprovação",
  TERMO_INVALIDADO: "Termo rejeitado, removido ou incompleto depois da aprovação",
  TITULO_EM_CONFIRMACAO: "Título do aluno entrou em confirmação depois da aprovação",
  ACORDO_CONDICOES_ALTERADAS: "Condições do acordo mudaram depois da aprovação (valor, parcelas ou vencimentos)",
  ACORDO_REATIVADO: "Acordo cancelado depois da aprovação e reativado",
  ACORDO_QUEBRADO_SEM_REVISAO: "Acordo quebrado ou com saldo alterado depois da aprovação: análise da gestão",
  ACORDO_ATIVO_SEM_APROVACAO: "Acordo regularizado (em dia) depois da aprovação, sem aprovação específica",
};

export function rotuloDivergencia(codigo) {
  return DIVERGENCIAS[codigo] || codigo;
}

// '!' na frente = impeditiva: não há liberação pela tela.
export function pendenciaImpeditiva(codigo) {
  return String(codigo || "").startsWith("!");
}

export function rotuloPendencia(codigo) {
  const limpo = String(codigo || "").replace(/^!/, "");
  if (limpo.startsWith("BLOQUEIO_ADMINISTRATIVO:")) {
    return `Aluno já fora da cobrança (${limpo.split(":")[1].replace(/_/g, " ").toLowerCase()})`;
  }
  return PENDENCIAS[limpo] || limpo;
}

export function rotuloTermo(conferencia, caso) {
  if (caso?.doc_manual) return "Documento vinculado manualmente";
  if (caso?.doc_autorizado_em) return "Pendência autorizada pelo jurídico";
  const s = conferencia?.termo?.status;
  if (s === "LOCALIZADO") return "Termo assinado localizado";
  if (s === "VALIDAR") return "Termo precisa de validação";
  if (s === "NAO_LOCALIZADO") return "Termo NÃO localizado";
  return "Sem acordo: não se aplica";
}

export const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// 'AAAA-MM-DD' -> 'DD/MM/AAAA' sem passar por Date (não desloca por fuso).
export function dataBr(d) {
  const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

export function cpfFormatado(cpf) {
  const d = String(cpf || "").replace(/\D/g, "");
  if (d.length !== 11) return String(cpf || "");
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

// O Excel sai do sistema: leva, por caso, o que mudou desde a aprovação.
const CONFERENCIA = {
  CONFERIDO: "Conferido",
  REVISAO_NECESSARIA: "Revisão necessária",
  NAO_ENCAMINHAVEL: "Não encaminhável",
};
export function rotuloConferencia(c) {
  return CONFERENCIA[c?.conferencia_status] || ((c?.divergencias || []).length ? "Revisão necessária" : "Conferido");
}

export function situacaoNaGeracao(c) {
  const d = c?.divergencias || [];
  return d.length ? `ATENÇÃO: ${d.map(rotuloDivergencia).join("; ")}` : "Sem alteração desde a aprovação";
}

function pendenciasDoCaso(c) {
  const p = [];
  if (c.acordo_ativo_motivo) p.push(`Acordo ativo aprovado: ${c.acordo_ativo_motivo}`);
  if (c.documento_autorizacao) p.push(`Termo pendente, autorizado: ${c.documento_autorizacao}`);
  return p.join(" | ");
}

// Uma linha por TÍTULO (é o que o financeiro baixa) e uma por ALUNO (resumo).
export function linhasDoLote(payload) {
  const titulos = [];
  const alunos = [];
  for (const c of payload?.casos || []) {
    const lista = c.titulos || [];
    const soma = (tipo) =>
      lista.filter((t) => t.tipo === tipo).reduce((s, t) => s + Number(t.valor || 0), 0);
    const acordos = [...new Set(lista.filter((t) => t.acordo_numero).map((t) => t.acordo_numero))];
    const base = {
      protocolo: payload.protocolo,
      aluno: c.aluno || "",
      cpf: cpfFormatado(c.cpf),
      matricula: c.matricula || "",
      situacao_academica: c.situacao_academica || "",
      conferencia: rotuloConferencia(c),
      situacao_geracao: situacaoNaGeracao(c),
    };
    alunos.push({
      ...base,
      curso: c.curso || "",
      qtd_titulos: lista.length,
      valor_mensalidades: soma("MENSALIDADE"),
      valor_acordos: soma("PARCELA_ACORDO"),
      valor_total: soma("MENSALIDADE") + soma("PARCELA_ACORDO"),
      acordos: acordos.join(", "),
      documento: c.documento || "",
      aprovado_por: c.aprovado_por || "",
      aprovado_em: dataBr(c.aprovado_em),
      documento_ref: c.documento_ref || "",
      pendencias: pendenciasDoCaso(c),
    });
    for (const t of lista) {
      titulos.push({
        ...base,
        tipo: t.tipo === "PARCELA_ACORDO" ? "Parcela de acordo" : "Mensalidade",
        documento: t.documento || "",
        vencimento: dataBr(t.vencimento),
        valor: Number(t.valor || 0),
        acordo: t.acordo_numero ? String(t.acordo_numero) : "",
        acordo_ulbra: t.acordo_ulbra || "",
        acordo_status: t.acordo_status || "",
        pendencias: pendenciasDoCaso(c),
      });
    }
  }
  return { titulos, alunos };
}

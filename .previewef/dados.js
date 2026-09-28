// PRÉVIA -- o que aqui é MEDIDO e o que é DEMONSTRAÇÃO.
//
// MEDIDO em produção, somente leitura, em 28/09/2026: o objeto `TOTAL` abaixo.
// São os números reais do semestre 2026/2 naquele instante -- inclusive o
// `cancelado_titulos: 1`, que é o único título com situação CANCELADA.
//
// DEMONSTRAÇÃO: a quebra por mês. O recorte por competência não foi medido
// campo a campo; os meses aqui repartem os totais proporcionalmente ao valor,
// só para a tela ter números coerentes entre si. NÃO leia os cards de mês
// desta prévia como medição.
//
// DEMONSTRAÇÃO também: as linhas do detalhe -- nomes, CPFs e documentos são
// inventados. Nenhum dado pessoal de produção entra aqui.
//
// Por que o total de cancelados é 1 e não 15: 15 era um número que esta prévia
// inventava, quando ela repartia proporcionalmente TODOS os indicadores,
// inclusive os cancelados. A medição real diz 1 título / R$ 10.399,64. O
// número inventado foi removido; o total agora é o medido.

// MEDIDO -- 28/09/2026, produção, somente leitura.
const TOTAL = {
  competencias: 6, titulos: 2525, alunos: 1913,
  valor_original: 5157800.55,
  recuperado: 543389.54, titulos_com_pagamento: 313, titulos_liquidados: 276,
  convertido_titulos: 379, convertido_valor: 708390.51,
  conferencia_titulos: 585, conferencia_valor: 1529202.33,
  academico_titulos: 62, academico_valor: 140360.83,
  sem_negociacao_titulos: 1498, sem_negociacao_valor: 2769447.24,
  cancelado_titulos: 1, cancelado_valor: 10399.64,
  saldo_titulos: 2248, saldo_valor: 4604011.37,
  fallback_titulos: 160, fallback_valor: 42574.66,
  acordos_cancelados: 11, acordos_cancelados_valor: 24180.10,  // DEMONSTRAÇÃO
};
// MEDIDO -- as duas marcas novas, no mesmo instante.
const TAB = {
  tab_cancelamento_titulos: 29, tab_cancelamento_valor: 99160.73,
  tab_suspensao_titulos: 72,    tab_suspensao_valor: 152779.86,
};

// DEMONSTRAÇÃO -- a quebra por mês.
const COMP = [
  { competencia: "2026-04-01", titulos: 3,    alunos: 3,    valor_original: 2680.77 },
  { competencia: "2026-05-01", titulos: 59,   alunos: 46,   valor_original: 123282.11 },
  { competencia: "2026-06-01", titulos: 156,  alunos: 122,  valor_original: 268126.97 },
  { competencia: "2026-07-01", titulos: 793,  alunos: 690,  valor_original: 1951591.07 },
  { competencia: "2026-08-01", titulos: 1513, alunos: 1192, valor_original: 2798476.30 },
  { competencia: "2026-12-01", titulos: 1,    alunos: 1,    valor_original: 13643.33 },
];

function mes(b, comTabulacao) {
  const p = b.valor_original / TOTAL.valor_original;
  const r = (v) => Math.round(v * p * 100) / 100;
  const n = (v) => Math.max(0, Math.round(v * p));
  const base = {
    ...b, vencimento_de: b.competencia, vencimento_ate: b.competencia,
    recuperado: r(TOTAL.recuperado),
    titulos_com_pagamento: n(TOTAL.titulos_com_pagamento),
    titulos_liquidados: n(TOTAL.titulos_liquidados),
    convertido_titulos: n(TOTAL.convertido_titulos), convertido_valor: r(TOTAL.convertido_valor),
    conferencia_titulos: n(TOTAL.conferencia_titulos), conferencia_valor: r(TOTAL.conferencia_valor),
    academico_titulos: n(TOTAL.academico_titulos), academico_valor: r(TOTAL.academico_valor),
    sem_negociacao_titulos: n(TOTAL.sem_negociacao_titulos),
    sem_negociacao_valor: r(TOTAL.sem_negociacao_valor),
    cancelado_titulos: n(TOTAL.cancelado_titulos), cancelado_valor: r(TOTAL.cancelado_valor),
    acordos_cancelados: n(TOTAL.acordos_cancelados),
    acordos_cancelados_valor: r(TOTAL.acordos_cancelados_valor),
    saldo_titulos: n(TOTAL.saldo_titulos), saldo_valor: r(TOTAL.saldo_valor),
    fallback_titulos: n(TOTAL.fallback_titulos), fallback_valor: r(TOTAL.fallback_valor),
  };
  if (comTabulacao) {
    base.tab_cancelamento_titulos = n(TAB.tab_cancelamento_titulos);
    base.tab_cancelamento_valor = r(TAB.tab_cancelamento_valor);
    base.tab_suspensao_titulos = n(TAB.tab_suspensao_titulos);
    base.tab_suspensao_valor = r(TAB.tab_suspensao_valor);
  }
  return base;
}

export function painel(comTabulacao) {
  // O total é o MEDIDO, não a soma dos meses de demonstração: arredondar seis
  // rateios e somar daria um número que nunca existiu em lugar nenhum.
  const total = { ...TOTAL, ...(comTabulacao ? TAB : {}) };
  return {
    gerado_em: "2026-09-28T14:00:00Z", semestre: "2026/2",
    atualizado_em: { prime_coletado_em: "2026-09-27T07:07:00Z",
                     ultima_entrada: "2026-08-14", titulo_mexido_em: "2026-09-28T06:00:00Z" },
    total,
    // MEDIDO: há um único título CANCELADO, e o motivo dele.
    cancelados_por_motivo: [
      { motivo: "Sem motivo registrado", titulos: 1, valor: 10399.64 },
    ],
    competencias: COMP.map((b) => mes(b, comTabulacao)),
  };
}

// DEMONSTRAÇÃO -- linhas inventadas, para mostrar o painel de detalhe.
const NOMES = ["Mariana Alves Teixeira", "Joao Pedro Nogueira", "Beatriz Campos Lima",
               "Rafael Moura Drummond", "Helena Vasconcelos Sa", "Otavio Bittencourt Reis"];

export function detalhe(indicador, comFicha) {
  const situacoes = indicador === "em_conferencia"
    ? ["Liquidado no Prime, origem não comprovada",
       "Aberto no Prime, mas paga acordo fora do CRM",
       "Sem confirmação do Prime (título não encontrado)"]
    : ["Sem pagamento e sem negociação"];
  const linhas = NOMES.map((nome, i) => ({
    aluno: nome,
    cpf: "***.***." + String(100 + i) + "-**",
    documento: i === 2 ? "MANUAL-8f3a1c22-2026-01-20261205-1364333" : String(4130000 + i * 37),
    vencimento: ["2026-07-05", "2026-08-05", "2026-08-05", "2026-06-05", "2026-08-05", "2026-12-05"][i],
    competencia: ["2026-07-01", "2026-08-01", "2026-08-01", "2026-06-01", "2026-08-01", "2026-12-01"][i],
    situacao: situacoes[i % situacoes.length],
    valor_original: [1571.55, 987.40, 13643.33, 2210.00, 1180.25, 764.90][i],
    recuperado: [1100.09, 0, 0, 1105.00, 0, 0][i],
    saldo: [471.46, 987.40, 13643.33, 1105.00, 1180.25, 764.90][i],
    ...(comFicha ? { aluno_id: "00000000-0000-4000-8000-00000000000" + i } : {}),
    // Campos que so existem depois da migration desta proposta. Sao eles que a
    // tela devolve ao salvar (regra 6).
    titulo_id: "11111111-1111-4111-8111-11111111111" + i,
    situacao_crm: i === 4 ? "PAGO" : "ABERTO",   // o 5o simula estado que mudou
    prime_liquidado: i === 0 ? "2026-09-09" : null,
    conferido_por: null, conferido_em: null,
  }));
  return {
    indicador, total_titulos: linhas.length,
    total_valor: Math.round(linhas.reduce((a, l) => a + l.valor_original, 0) * 100) / 100,
    linhas,
  };
}

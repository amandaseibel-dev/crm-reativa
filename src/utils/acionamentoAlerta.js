// SITUAÇÃO DE ACIONAMENTO de uma linha de alerta de parcela. Funções PURAS.
//
// O QUE EXISTE PARA COMPROVAR, conferido em produção em 21/10/2026
//
// NENHUMA tabela de contato carrega `parcela_id`. A única do schema que tem é
// `solicitacoes_confirmacao_pagamento`, que é pedido de confirmação de
// pagamento -- não é acionamento. E as tabelas de movimentação por aluno estão
// mortas ou vazias:
//
//   historico_operacional   34.330 linhas, mas aluno_id, data_acao e
//                           acao_realizada 100% NULOS; ultimo created_at 30/06
//   historico_casos         0 linhas
//   historico_atendimentos  0 linhas
//   operador_atendimentos   0 linhas
//
// Sobra UMA fonte viva por aluno: `casos.data_ultimo_acionamento` (18.150 casos
// preenchidos). Ela diz QUANDO o aluno foi acionado pela última vez. Não diz
// sobre QUAL parcela, nem por qual canal, nem se foi individual ou massiva --
// `casos` não tem coluna de natureza do acionamento.
//
// DAÍ A REGRA DESTE ARQUIVO: o rótulo fala do ALUNO, nunca da parcela. Não se
// presume que o contato tenha sido o aviso daquela parcela. O que é afirmado é
// só o que está registrado: houve acionamento do aluno em tal data, e essa data
// é anterior ou posterior ao vencimento desta parcela -- uma comparação de
// datas, verificável.
//
// O "antes do vencimento" é o sinal que mais importa: aviso preventivo NÃO
// substitui o aviso depois do vencimento. Medido no universo real das 1.022
// parcelas vencidas: 684 com acionamento APÓS, 170 só ANTES, 74 no próprio dia,
// 71 hoje e 23 sem caso.

export const SEM_AVISO = "Sem aviso específico identificado";
export const NAO_ACIONADO = "Não acionado";

// Buckets de prioridade: quanto MENOR, mais em evidência no recorte compacto.
// Nao contraria a prioridade operacional ja estabelecida (dias_restantes) --
// ela continua ordenando DENTRO de cada bucket.
export const PRIORIDADE = {
  SEM_CASO: 0,       // ninguem acompanha: e o pior caso
  NAO_ACIONADO: 1,   // tem dono e nunca foi acionado
  SO_ANTES: 2,       // so houve aviso preventivo; o pos-vencimento nao aconteceu
  NO_DIA: 3,
  ACIONADO: 4,       // ja houve acionamento depois do vencimento
};

function diasEntre(de, ate) {
  const a = Date.parse(`${String(de).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(ate).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

export function textoDias(n) {
  if (n === 0) return "hoje";
  if (n === 1) return "há 1 dia";
  return `há ${n} dias`;
}

// `temCaso` false = o alerta existe mas nenhum caso do aluno esta sob operador,
// entao nao ha nem de onde ler a data. Medido: 23 das 1.022.
export function situacaoAcionamento({ dua, vencimento, hoje, temCaso = true } = {}) {
  if (!temCaso) return { texto: SEM_AVISO, prioridade: PRIORIDADE.SEM_CASO, acionado: false };
  if (!dua) return { texto: NAO_ACIONADO, prioridade: PRIORIDADE.NAO_ACIONADO, acionado: false };

  const dias = diasEntre(dua, hoje);
  if (dias === null || dias < 0) {
    // Data futura ou ilegivel: nao da para afirmar nada sem presumir.
    return { texto: SEM_AVISO, prioridade: PRIORIDADE.SEM_CASO, acionado: false };
  }
  const base = dias === 0 ? "Acionado hoje" : `Acionado ${textoDias(dias)}`;

  const d = String(dua).slice(0, 10);
  const v = String(vencimento || "").slice(0, 10);
  if (!v) return { texto: base, prioridade: PRIORIDADE.ACIONADO, acionado: true };

  if (d < v) return { texto: `${base} · antes do vencimento`, prioridade: PRIORIDADE.SO_ANTES, acionado: true };
  if (d > v) return { texto: `${base} · após o vencimento`, prioridade: PRIORIDADE.ACIONADO, acionado: true };
  // Mesmo dia: nao da para dizer se foi antes ou depois de vencer.
  return { texto: base, prioridade: PRIORIDADE.NO_DIA, acionado: true };
}

// Dias de atraso para a linha de uma parcela VENCIDA. `dias_restantes` ja vem
// negativo da RPC; aqui so vira texto, sem recalcular nada.
export function textoVencimento(a, hoje) {
  const n = Number(a?.dias_restantes);
  if (Number.isFinite(n) && n < 0) {
    const d = Math.abs(n);
    return d === 1 ? "1 dia de atraso" : `${d} dias de atraso`;
  }
  if (Number.isFinite(n)) {
    if (n === 0) return "vence hoje";
    if (n === 1) return "vence amanhã";
    return `vence em ${n} dias`;
  }
  const dias = diasEntre(hoje, a?.vencimento);
  return dias === null ? "" : dias < 0 ? `${Math.abs(dias)} dias de atraso` : `vence em ${dias} dias`;
}

// Mapa aluno_id -> { dua, temCaso } a partir da fila de casos ja carregada na
// tela. NAO consulta nada: usa o que o painel ja tem em memoria.
export function indiceAcionamento(casos) {
  const m = new Map();
  for (const c of Array.isArray(casos) ? casos : []) {
    const id = String(c?.aluno_id || c?.id || "");
    if (!id) continue;
    const dua = c?.data_ultimo_acionamento || null;
    const atual = m.get(id);
    // Um aluno pode ter mais de um caso: fica a data mais RECENTE.
    if (!atual || (dua && String(dua) > String(atual.dua || ""))) m.set(id, { dua, temCaso: true });
  }
  return m;
}

// Ordena mantendo a prioridade operacional de dentro (a lista ja vem ordenada
// por dias_restantes) e trazendo para cima quem nao tem aviso comprovado.
export function ordenarPorAcionamento(lista, indice, hoje) {
  return [...(Array.isArray(lista) ? lista : [])]
    .map((a, i) => {
      const info = indice?.get ? indice.get(String(a.aluno_id)) : null;
      const s = situacaoAcionamento({ dua: info?.dua, vencimento: a.vencimento, hoje, temCaso: Boolean(info) });
      return { a, i, p: s.prioridade };
    })
    .sort((x, y) => x.p - y.p || x.i - y.i)
    .map((x) => x.a);
}

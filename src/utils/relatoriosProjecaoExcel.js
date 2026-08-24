// =============================================================================
// Geração dos relatórios de premiação (Excel .xlsx real + ZIP).
// Fonte ÚNICA: o snapshot (RPCs projecao_snapshot_*). NUNCA consulta
// public.pagamentos. Todos os arquivos de um pacote usam o mesmo atualizado_em.
//
// Estrutura: builders PUROS (montam AOA/worksheet — testáveis com vitest) +
// fetchers assíncronos (leem as RPCs paginadas) + orquestradores (montam o
// workbook e disparam o download).
// =============================================================================
import * as XLSX from "xlsx-js-style";
import JSZip from "jszip";
import { supabase } from "../services/supabase";
import { OPERADORES_POR_EMAIL, EQUIPE_9_EMAILS, ROTULO_CLASSIFICACAO } from "./operadores";

const FMT_MOEDA = 'R$ #,##0.00';
const FMT_PCT = '0.0"%"';
const FMT_INT = "#,##0";

const ESTILO_HEADER = {
  font: { bold: true, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: "1E40AF" } },
  alignment: { horizontal: "center", vertical: "center" },
};
const ESTILO_TOTAL = { font: { bold: true }, fill: { fgColor: { rgb: "EEF2FF" } } };

function dataBR(iso) {
  if (!iso) return "";
  const [a, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}
function nomeOp(email) {
  return OPERADORES_POR_EMAIL[String(email || "").toLowerCase()] || email || "-";
}
function slugNome(email) {
  return String(nomeOp(email)).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "");
}

// --- BUILDER PURO: cria uma worksheet a partir de colunas + linhas ----------
// colunas: [{ h, k, t: 'text'|'moeda'|'pct'|'int', w }]
// linhas: array de objetos. totais: objeto opcional (mesmo shape) destacado.
export function montarWorksheet(colunas, linhas, totais) {
  const aoa = [colunas.map((c) => c.h)];
  for (const l of linhas) aoa.push(colunas.map((c) => l[c.k] ?? (c.t === "text" ? "" : 0)));
  if (totais) aoa.push(colunas.map((c) => totais[c.k] ?? (c.t === "text" ? "" : 0)));
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  const nLinhas = aoa.length;
  for (let r = 0; r < nLinhas; r++) {
    for (let c = 0; c < colunas.length; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;
      if (r === 0) { cell.s = ESTILO_HEADER; continue; }
      const col = colunas[c];
      const ehTotal = totais && r === nLinhas - 1;
      if (col.t === "moeda") cell.z = FMT_MOEDA;
      else if (col.t === "pct") cell.z = FMT_PCT;
      else if (col.t === "int") cell.z = FMT_INT;
      if (ehTotal) cell.s = { ...(cell.s || {}), ...ESTILO_TOTAL };
    }
  }
  ws["!cols"] = colunas.map((c) => ({ wch: c.w || 16 }));
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, nLinhas - 1), c: colunas.length - 1 } }) };
  // Congela o cabeçalho (linha 1).
  ws["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" };
  return ws;
}

// --- BUILDERS de conteúdo (puros) -------------------------------------------
export function abaResumoPremiacao(payload, mes) {
  const linhas = [
    { campo: "Operador", valor: payload?.operador_nome || "-" },
    { campo: "Competência", valor: mes },
    { campo: "Quantidade de pagamentos (mês)", valor: qtdMes(payload) },
    { campo: "Recuperado no mês", valor: Number(payload?.acumulado_mes || 0) },
    { campo: "Honorários no mês (base de cálculo)", valor: Number(payload?.honorario_mes || 0) },
    { campo: "Faixa alcançada", valor: payload?.faixa_atual || "-" },
    { campo: "Percentual da faixa", valor: pctDaFaixa(payload) },
    { campo: "Premiação estimada", valor: Number(payload?.comissao_estimada_individual || 0) },
    { campo: "Próxima faixa (a partir de)", valor: Number(payload?.proxima_faixa_valor || 0) },
    { campo: "Falta para a próxima faixa", valor: Number(payload?.falta_proxima_faixa || 0) },
  ];
  // coluna "valor" mista -> texto; formata as monetárias manualmente na 3ª col.
  const colunas = [
    { h: "Indicador", k: "campo", t: "text", w: 38 },
    { h: "Valor", k: "valorFmt", t: "text", w: 28 },
  ];
  const linhasFmt = linhas.map((l) => ({
    campo: l.campo,
    valorFmt: typeof l.valor === "number"
      ? (l.campo.includes("Percentual") ? `${l.valor}%` : moedaTxt(l.valor))
      : l.valor,
  }));
  // mantém números crus para pagamentos/recuperado? Aqui é resumo textual.
  return montarWorksheet(colunas, linhasFmt);
}

export function abaEvolucaoDiaria(historico) {
  const colunas = [
    { h: "Dia", k: "dia", t: "text", w: 12 },
    { h: "Recuperado dia", k: "rec", t: "moeda", w: 16 },
    { h: "Honorário dia", k: "hon", t: "moeda", w: 16 },
    { h: "Qtd pagamentos", k: "qtd", t: "int", w: 14 },
    { h: "Recuperado acum.", k: "recAc", t: "moeda", w: 18 },
    { h: "Honorário acum.", k: "honAc", t: "moeda", w: 18 },
    { h: "% da meta", k: "pct", t: "pct", w: 12 },
    { h: "Faixa no dia", k: "faixa", t: "text", w: 20 },
    { h: "% comissão", k: "pctCom", t: "pct", w: 12 },
    { h: "Comissão estimada", k: "com", t: "moeda", w: 18 },
    { h: "Falta próx. faixa", k: "falta", t: "moeda", w: 18 },
  ];
  const linhas = (historico || []).map((d) => ({
    dia: dataBR(d.dia), rec: num(d.recuperado_dia ?? d.valor_recuperado), hon: num(d.honorario_dia ?? d.valor_honorario),
    qtd: num(d.qtd_pagamentos_dia), recAc: num(d.recuperado_acumulado), honAc: num(d.honorario_acumulado),
    pct: num(d.percentual_meta), faixa: d.faixa || "", pctCom: num(d.percentual_comissao),
    com: num(d.comissao_estimada), falta: num(d.falta_proxima_faixa),
  }));
  return montarWorksheet(colunas, linhas);
}

export function abaPagamentos(itens) {
  const colunas = [
    { h: "Data", k: "data", t: "text", w: 12 },
    { h: "Aluno", k: "aluno", t: "text", w: 34 },
    { h: "Pagamento (id)", k: "id", t: "text", w: 20 },
    { h: "Recuperado", k: "pago", t: "moeda", w: 16 },
    { h: "Honorário", k: "hon", t: "moeda", w: 16 },
    { h: "Origem/importação", k: "origem", t: "text", w: 22 },
    { h: "Ajuste operador", k: "ajuste", t: "text", w: 14 },
  ];
  const linhas = (itens || []).map((p) => ({
    data: dataBR(p.data_pagamento), aluno: p.aluno_nome || "-", id: String(p.pagamento_id || ""),
    pago: num(p.valor_pago), hon: num(p.valor_honorario),
    origem: p.importacao_id ? `Importação ${String(p.importacao_id).slice(0, 8)}` : "Manual/Direto",
    ajuste: p.operador_ajustado_manualmente ? "Sim" : "Não",
  }));
  const totais = {
    data: "TOTAL", aluno: `${linhas.length} pagamento(s)`, id: "",
    pago: soma(linhas, "pago"), hon: soma(linhas, "hon"), origem: "", ajuste: "",
  };
  return montarWorksheet(colunas, linhas, totais);
}

export function abaRegrasConferencia(payload, somaDetalhe) {
  const cfg = payload?.config_metas || {};
  const honMes = Number(payload?.honorario_mes || 0);
  const confHon = Math.abs(Number(somaDetalhe?.honorario || 0) - honMes) < 0.05;
  const confRec = Math.abs(Number(somaDetalhe?.recuperado || 0) - Number(payload?.acumulado_mes || 0)) < 0.05;
  const linhas = [
    { campo: "Faixa 1", valorFmt: `até ${moedaTxt(cfg.m2_valor)} = ${cfg.m1_percentual}%` },
    { campo: "Faixa 2", valorFmt: `${moedaTxt(cfg.m2_valor)} a ${moedaTxt(cfg.m3_valor)} = ${cfg.m2_percentual}%` },
    { campo: "Faixa 3", valorFmt: `${moedaTxt(cfg.m3_valor)} a ${moedaTxt(cfg.m4_valor)} = ${cfg.m3_percentual}%` },
    { campo: "Faixa 4", valorFmt: `acima de ${moedaTxt(cfg.m4_valor)} = ${cfg.m4_percentual}%` },
    { campo: "Base da comissão", valorFmt: "Honorário do mês" },
    { campo: "Conferência honorários (detalhe = snapshot)", valorFmt: confHon ? "CONFERE" : "DIVERGÊNCIA" },
    { campo: "Conferência recuperado (detalhe = snapshot)", valorFmt: confRec ? "CONFERE" : "DIVERGÊNCIA" },
  ];
  return montarWorksheet([
    { h: "Regra", k: "campo", t: "text", w: 44 },
    { h: "Detalhe", k: "valorFmt", t: "text", w: 40 },
  ], linhas);
}

export function abaResumoGeral(totaisPorClasse, filialPayload, mes, atualizadoEm) {
  const colunas = [
    { h: "Classificação", k: "classe", t: "text", w: 26 },
    { h: "Qtd", k: "qtd", t: "int", w: 12 },
    { h: "Recuperado", k: "pago", t: "moeda", w: 18 },
    { h: "Honorário", k: "hon", t: "moeda", w: 18 },
    { h: "Participa premiação", k: "premia", t: "text", w: 18 },
  ];
  const linhas = (totaisPorClasse || []).map((t) => ({
    classe: ROTULO_CLASSIFICACAO[t.classificacao] || t.classificacao,
    qtd: num(t.qtd), pago: num(t.total_pago), hon: num(t.total_honorario),
    premia: t.participa_premiacao ? "Sim" : "Não",
  }));
  const totais = {
    classe: "TOTAL DA EMPRESA", qtd: soma(linhas, "qtd"),
    pago: soma(linhas, "pago"), hon: soma(linhas, "hon"), premia: "",
  };
  return montarWorksheet(colunas, linhas, totais);
}

export function abaPremiacaoSintetica(operadoresPayloadPorEmail, mes) {
  const colunas = [
    { h: "Operador", k: "op", t: "text", w: 22 },
    { h: "Qtd pagamentos", k: "qtd", t: "int", w: 14 },
    { h: "Recuperado", k: "rec", t: "moeda", w: 18 },
    { h: "Honorário (base)", k: "hon", t: "moeda", w: 18 },
    { h: "Faixa", k: "faixa", t: "text", w: 20 },
    { h: "% faixa", k: "pct", t: "pct", w: 10 },
    { h: "Premiação", k: "premia", t: "moeda", w: 16 },
  ];
  const linhas = EQUIPE_9_EMAILS.map((email) => {
    const p = operadoresPayloadPorEmail[email] || {};
    return {
      op: nomeOp(email), qtd: qtdMes(p), rec: num(p.acumulado_mes), hon: num(p.honorario_mes),
      faixa: p.faixa_atual || "-", pct: pctDaFaixa(p), premia: num(p.comissao_estimada_individual),
    };
  });
  const totais = {
    op: "TOTAL (9)", qtd: soma(linhas, "qtd"), rec: soma(linhas, "rec"),
    hon: soma(linhas, "hon"), faixa: "", pct: "", premia: soma(linhas, "premia"),
  };
  return montarWorksheet(colunas, linhas, totais);
}

export function abaGeralPagamentos(itens) {
  const colunas = [
    { h: "Data", k: "data", t: "text", w: 12 },
    { h: "Classificação", k: "classe", t: "text", w: 20 },
    { h: "Operador", k: "op", t: "text", w: 24 },
    { h: "Aluno", k: "aluno", t: "text", w: 34 },
    { h: "Pagamento (id)", k: "id", t: "text", w: 20 },
    { h: "Recuperado", k: "pago", t: "moeda", w: 16 },
    { h: "Honorário", k: "hon", t: "moeda", w: 16 },
    { h: "Premiação", k: "premia", t: "text", w: 12 },
  ];
  const linhas = (itens || []).map((p) => ({
    data: dataBR(p.data_pagamento), classe: ROTULO_CLASSIFICACAO[p.classificacao_pagamento] || p.classificacao_pagamento,
    op: p.operador_email && p.operador_email !== "SEM_OPERADOR" && p.operador_email !== "PAGAMENTO_DIRETO" ? nomeOp(p.operador_email) : (p.operador_email || "-"),
    aluno: p.aluno_nome || "-", id: String(p.pagamento_id || ""),
    pago: num(p.valor_pago), hon: num(p.valor_honorario), premia: p.participa_premiacao ? "Sim" : "Não",
  }));
  const totais = { data: "TOTAL", classe: "", op: "", aluno: `${linhas.length} pagamento(s)`, id: "", pago: soma(linhas, "pago"), hon: soma(linhas, "hon"), premia: "" };
  return montarWorksheet(colunas, linhas, totais);
}

// --- Relatório por operador e vencimento -------------------------------------
export const ROTULO_SITUACAO_VENCIMENTO = {
  EM_DIA: "Em dia",
  ADIANTADO: "Adiantado",
  ATRASADO: "Atrasado",
  SEM_VENCIMENTO: "Sem vencimento",
};

export function abaResumoVencimento(resumoPorOperador) {
  const colunas = [
    { h: "Operador", k: "op", t: "text", w: 24 },
    { h: "Qtd", k: "qtd", t: "int", w: 10 },
    { h: "Em dia", k: "emDia", t: "int", w: 10 },
    { h: "Adiantado", k: "adiantado", t: "int", w: 11 },
    { h: "Atrasado", k: "atrasado", t: "int", w: 10 },
    { h: "Sem vencimento", k: "semVenc", t: "int", w: 15 },
    { h: "Recuperado", k: "pago", t: "moeda", w: 18 },
    { h: "Honorário", k: "hon", t: "moeda", w: 18 },
  ];
  const linhas = (resumoPorOperador || []).map((r) => ({
    op: r.operador_email === "SEM_OPERADOR" ? "Sem operador" : nomeOp(r.operador_email) || r.operador_nome || "-",
    qtd: num(r.qtd), emDia: num(r.qtd_em_dia), adiantado: num(r.qtd_adiantado),
    atrasado: num(r.qtd_atrasado), semVenc: num(r.qtd_sem_vencimento),
    pago: num(r.soma_pago), hon: num(r.soma_honorario),
  }));
  const totais = {
    op: "TOTAL", qtd: soma(linhas, "qtd"), emDia: soma(linhas, "emDia"),
    adiantado: soma(linhas, "adiantado"), atrasado: soma(linhas, "atrasado"),
    semVenc: soma(linhas, "semVenc"), pago: soma(linhas, "pago"), hon: soma(linhas, "hon"),
  };
  return montarWorksheet(colunas, linhas, totais);
}

export function abaPagamentosVencimento(itens) {
  const colunas = [
    { h: "Operador", k: "op", t: "text", w: 22 },
    { h: "Aluno", k: "aluno", t: "text", w: 34 },
    { h: "Título", k: "titulo", t: "text", w: 12 },
    { h: "Parcela", k: "parcela", t: "text", w: 14 },
    { h: "Vencimento", k: "venc", t: "text", w: 12 },
    { h: "Data pagamento", k: "dataPag", t: "text", w: 14 },
    { h: "Situação", k: "sit", t: "text", w: 14 },
    { h: "Dias de atraso", k: "dias", t: "int", w: 13 },
    { h: "Valor original", k: "orig", t: "moeda", w: 15 },
    { h: "Recuperado", k: "pago", t: "moeda", w: 16 },
    { h: "Honorário", k: "hon", t: "moeda", w: 16 },
  ];
  const linhas = (itens || []).map((p) => ({
    op: p.operador_email === "SEM_OPERADOR" ? (p.operador_nome ? `Sem operador (${p.operador_nome})` : "Sem operador") : nomeOp(p.operador_email),
    aluno: p.aluno_nome || "-", titulo: String(p.titulo_numero || ""),
    parcela: String(p.numero_parcela_completo || ""),
    venc: dataBR(p.vencimento), dataPag: dataBR(p.data_pagamento),
    sit: ROTULO_SITUACAO_VENCIMENTO[p.situacao] || p.situacao || "-",
    dias: p.dias_diferenca == null ? "" : num(p.dias_diferenca),
    orig: num(p.valor_original), pago: num(p.valor_pago), hon: num(p.valor_honorario),
  }));
  const totais = {
    op: "TOTAL", aluno: `${linhas.length} pagamento(s)`, titulo: "", parcela: "",
    venc: "", dataPag: "", sit: "", dias: "",
    orig: soma(linhas, "orig"), pago: soma(linhas, "pago"), hon: soma(linhas, "hon"),
  };
  return montarWorksheet(colunas, linhas, totais);
}

// Fetcher paginado da RPC do relatório por vencimento (só gestão no backend).
export async function buscarPagamentosVencimento(mes, filtros = {}) {
  const params = {
    p_mes: mes,
    p_operadores: filtros.operadores && filtros.operadores.length ? filtros.operadores : null,
    p_venc_de: filtros.vencDe || null,
    p_venc_ate: filtros.vencAte || null,
    p_incluir_sem_vencimento: filtros.incluirSemVencimento !== false,
  };
  const itens = [];
  let resumoOperador = [];
  let offset = 0; const limit = 500;
  for (let guarda = 0; guarda < 400; guarda++) {
    const { data, error } = await supabase.rpc("projecao_relatorio_pagamentos_vencimento", {
      ...params, p_limit: limit, p_offset: offset,
    });
    if (error) throw error;
    if (offset === 0) resumoOperador = data?.resumo_por_operador || [];
    const lote = data?.itens || [];
    itens.push(...lote);
    if (lote.length < limit) return { itens, resumoOperador };
    offset += limit;
  }
  return { itens, resumoOperador };
}

export function montarWorkbookVencimento(dados) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, abaResumoVencimento(dados.resumoOperador), "Resumo por Operador");
  XLSX.utils.book_append_sheet(wb, abaPagamentosVencimento(dados.itens), "Pagamentos");
  return wb;
}

export async function exportarPagamentosPorVencimento(mes, filtros = {}) {
  const dados = await buscarPagamentosVencimento(mes, filtros);
  const sufixoVenc = filtros.vencDe || filtros.vencAte
    ? `_venc_${filtros.vencDe || "inicio"}_a_${filtros.vencAte || "fim"}`
    : "";
  baixarBlob(`Relatorio_Vencimento_Reativa_${mes}${sufixoVenc}.xlsx`, wbParaBlob(montarWorkbookVencimento(dados)));
}

// --- helpers ----------------------------------------------------------------
function num(v) { const n = Number(v); return Number.isNaN(n) ? 0 : n; }
function soma(linhas, k) { return linhas.reduce((s, l) => s + Number(l[k] || 0), 0); }
function moedaTxt(v) { return Number(num(v)).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function qtdMes(payload) {
  return (payload?.historico_dia_a_dia || []).reduce((s, d) => s + Number(d.qtd_pagamentos_dia || 0), 0);
}
function pctDaFaixa(payload) {
  const m = String(payload?.faixa_atual || "").match(/\(([\d.]+)%\)/);
  if (m) return Number(m[1]);
  if (/ADM/.test(payload?.faixa_atual || "")) return 8;
  return 0;
}

// --- FETCHERS (snapshot; nunca public.pagamentos) ---------------------------
export async function buscarPagamentosOperador(mes, operadorEmail) {
  const itens = [];
  let offset = 0; const limit = 200;
  for (let guarda = 0; guarda < 200; guarda++) {
    const { data, error } = await supabase.rpc("projecao_snapshot_pagamentos_ler", {
      p_mes: mes, p_dia: null, p_operador_email: operadorEmail, p_limit: limit, p_offset: offset,
    });
    if (error) throw error;
    const lote = data?.itens || [];
    itens.push(...lote);
    if (lote.length < limit) return { itens, soma_pago: Number(data?.soma_pago || 0), soma_honorario: Number(data?.soma_honorario || 0) };
    offset += limit;
  }
  return { itens, soma_pago: 0, soma_honorario: 0 };
}

export async function buscarGeral(mes) {
  const itens = []; let totais = []; let offset = 0; const limit = 500;
  for (let guarda = 0; guarda < 400; guarda++) {
    const { data, error } = await supabase.rpc("projecao_snapshot_pagamentos_geral_ler", {
      p_mes: mes, p_classificacao: null, p_limit: limit, p_offset: offset,
    });
    if (error) throw error;
    if (offset === 0) totais = data?.totais_por_classificacao || [];
    const lote = data?.itens || [];
    itens.push(...lote);
    if (lote.length < limit) return { itens, totais };
    offset += limit;
  }
  return { itens, totais };
}

// --- download helpers -------------------------------------------------------
function wbParaBlob(wb) {
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
function baixarBlob(nome, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nome; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// --- montagem de workbooks --------------------------------------------------
export function montarWorkbookIndividual(payload, mes, pagamentos) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, abaResumoPremiacao(payload, mes), "Resumo da Premiação");
  XLSX.utils.book_append_sheet(wb, abaPagamentos(pagamentos.itens), "Pagamentos do Operador");
  XLSX.utils.book_append_sheet(wb, abaEvolucaoDiaria(payload?.historico_dia_a_dia), "Evolução Diária");
  XLSX.utils.book_append_sheet(wb, abaRegrasConferencia(payload, { honorario: pagamentos.soma_honorario, recuperado: pagamentos.soma_pago }), "Regras e Conferência");
  return wb;
}
export function montarWorkbookGeral(filialPayload, geral, mes, operadoresPayloadPorEmail) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, abaResumoGeral(geral.totais, filialPayload, mes), "Resumo Geral");
  XLSX.utils.book_append_sheet(wb, abaPremiacaoSintetica(operadoresPayloadPorEmail || {}, mes), "Premiação RH (9)");
  XLSX.utils.book_append_sheet(wb, abaGeralPagamentos(geral.itens), "Relatório Geral Pagamentos");
  return wb;
}

// Relatório Geral de Pagamentos (foco no analítico + resumo por classificação).
export function montarWorkbookGeralPagamentos(geral, mes) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, abaResumoGeral(geral.totais, null, mes), "Resumo por Classificação");
  XLSX.utils.book_append_sheet(wb, abaGeralPagamentos(geral.itens), "Todos os Pagamentos");
  return wb;
}

export function nomeArquivoIndividual(email, mes) { return `Premiacao_Reativa_${slugNome(email)}_${mes}.xlsx`; }
export function nomeArquivoGeral(mes) { return `Relatorio_Geral_RH_Reativa_${mes}.xlsx`; }

// --- ORQUESTRADORES (chamados pela UI) --------------------------------------
export async function exportarIndividual(mes, operadorEmail, payload) {
  const pagamentos = await buscarPagamentosOperador(mes, operadorEmail);
  const wb = montarWorkbookIndividual(payload, mes, pagamentos);
  baixarBlob(nomeArquivoIndividual(operadorEmail, mes), wbParaBlob(wb));
}

export async function exportarGeralRH(mes, filialPayload, operadoresPayloadPorEmail) {
  const geral = await buscarGeral(mes);
  const wb = montarWorkbookGeral(filialPayload, geral, mes, operadoresPayloadPorEmail);
  baixarBlob(nomeArquivoGeral(mes), wbParaBlob(wb));
}

export async function exportarGeralPagamentos(mes) {
  const geral = await buscarGeral(mes);
  const wb = montarWorkbookGeralPagamentos(geral, mes);
  baixarBlob(`Relatorio_Geral_Pagamentos_Reativa_${mes}.xlsx`, wbParaBlob(wb));
}

// PURO/testável: monta o ZIP dos 9 individuais a partir de dados já carregados
// (payload por email + pagamentos por email). Retorna o objeto JSZip.
export function montarZipIndividuais(mes, operadoresPayloadPorEmail, pagamentosPorEmail) {
  const zip = new JSZip();
  for (const email of EQUIPE_9_EMAILS) {
    const payload = operadoresPayloadPorEmail[email];
    if (!payload) continue;
    const pagamentos = pagamentosPorEmail[email] || { itens: [], soma_pago: 0, soma_honorario: 0 };
    const wb = montarWorkbookIndividual(payload, mes, pagamentos);
    zip.file(nomeArquivoIndividual(email, mes), XLSX.write(wb, { bookType: "xlsx", type: "array" }));
  }
  return zip;
}

export async function exportarTodosIndividuais(mes, operadoresPayloadPorEmail) {
  const pagamentosPorEmail = {};
  for (const email of EQUIPE_9_EMAILS) {
    if (operadoresPayloadPorEmail[email]) pagamentosPorEmail[email] = await buscarPagamentosOperador(mes, email);
  }
  const zip = montarZipIndividuais(mes, operadoresPayloadPorEmail, pagamentosPorEmail);
  baixarBlob(`Relatorios_Individuais_Reativa_${mes}.zip`, await zip.generateAsync({ type: "blob" }));
}

export async function exportarPacoteCompleto(mes, filialPayload, operadoresPayloadPorEmail) {
  const zip = new JSZip();
  const geral = await buscarGeral(mes);
  const wbGeral = montarWorkbookGeral(filialPayload, geral, mes, operadoresPayloadPorEmail);
  zip.file(nomeArquivoGeral(mes), XLSX.write(wbGeral, { bookType: "xlsx", type: "array" }));
  for (const email of EQUIPE_9_EMAILS) {
    const payload = operadoresPayloadPorEmail[email];
    if (!payload) continue;
    const pagamentos = await buscarPagamentosOperador(mes, email);
    const wb = montarWorkbookIndividual(payload, mes, pagamentos);
    zip.file(nomeArquivoIndividual(email, mes), XLSX.write(wb, { bookType: "xlsx", type: "array" }));
  }
  const blob = await zip.generateAsync({ type: "blob" });
  baixarBlob(`Pacote_Completo_RH_Reativa_${mes}.zip`, blob);
}

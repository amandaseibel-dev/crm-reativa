// Exportação Excel da Saúde Completa da Carteira.
// Usa exceljs. Recebe o payload da RPC public.saude_carteira_exportar
// (resumo + qualidade + detalhamento) — logo, filtros ativos, moeda BRL,
// datas DD/MM/AAAA, cabeçalho congelado, autofiltro, linhas alternadas.
// Dados já vêm mascarados do backend (sem CPF/telefone completos).
import ExcelJS from "exceljs";

const AZUL = "FF1E40AF";
const AZUL_CLARO = "FFEFF3FF";
const CINZA = "FFF1F5F9";

const FAIXA_ATRASO_LABEL = {
  A_VENCER: "A vencer", "1_30": "1-30 dias", "31_60": "31-60 dias", "61_90": "61-90 dias",
  "91_180": "91-180 dias", "181_365": "181-365 dias", MAIS_365: "Mais de 365 dias",
};
const TEMPO_LABEL = {
  NUNCA: "Nunca", "1D": "1 dia", "2_3D": "2 a 3 dias", "4_5D": "4 a 5 dias",
  "6_7D": "6 a 7 dias", "8_15D": "8 a 15 dias", "16_30D": "16 a 30 dias", MAIS_30D: "Mais de 30 dias",
};

function dataArquivo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}_${p(d.getMonth() + 1)}_${d.getFullYear()}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function estilizarCabecalho(ws, ncols) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  row.height = 26;
  for (let c = 1; c <= ncols; c++) {
    row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
    row.getCell(c).border = { bottom: { style: "thin", color: { argb: "FFCBD5E1" } } };
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ncols } };
}

function zebrar(ws, ncols) {
  ws.eachRow((row, i) => {
    if (i === 1) return;
    if (i % 2 === 0) {
      for (let c = 1; c <= ncols; c++) {
        if (!row.getCell(c).fill || row.getCell(c).fill.pattern !== "solid")
          row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: CINZA } };
      }
    }
  });
}

function autoLargura(ws) {
  ws.columns.forEach((col) => {
    let max = 10;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const v = cell.value == null ? "" : String(cell.value.text ?? cell.value);
      if (v.length > max) max = v.length;
    });
    col.width = Math.min(Math.max(max + 2, 10), 42);
  });
}

// aba genérica a partir de colunas [{header, key, width, money, date, pct}]
function addAba(wb, nome, colunas, linhas) {
  const ws = wb.addWorksheet(nome.substring(0, 31), { properties: { defaultRowHeight: 16 } });
  ws.columns = colunas.map((c) => ({ header: c.header, key: c.key, width: c.width || 16 }));
  linhas.forEach((l) => ws.addRow(l));
  colunas.forEach((c, idx) => {
    if (c.money) ws.getColumn(idx + 1).numFmt = 'R$ #,##0.00';
    if (c.pct) ws.getColumn(idx + 1).numFmt = '0.0"%"';
    if (c.date) ws.getColumn(idx + 1).numFmt = "dd/mm/yyyy";
  });
  estilizarCabecalho(ws, colunas.length);
  zebrar(ws, colunas.length);
  ws.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: "landscape" };
  return ws;
}

async function carregarLogo(wb) {
  try {
    const resp = await fetch("/logo_oficial_email.png");
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    return wb.addImage({ buffer: buf, extension: "png" });
  } catch {
    return null;
  }
}

export async function exportarSaudeCarteira(payload, filtrosAtivos) {
  const resumo = payload?.resumo || {};
  const totais = resumo.totais || {};
  const estabs = resumo.estabelecimentos || [];
  const mtxFaixa = resumo.matriz_faixa_atraso || [];
  const mtxTempo = resumo.matriz_tempo_sem_acionamento || [];
  const operadores = resumo.operadores || [];
  const qualidade = payload?.qualidade?.qualidade || {};
  const detalhe = payload?.detalhamento?.rows || [];

  const wb = new ExcelJS.Workbook();
  wb.creator = "Reativa CRM";
  wb.created = new Date();
  const logoId = await carregarLogo(wb);

  // 1) RESUMO GERAL — com logo no topo
  const wsResumo = wb.addWorksheet("RESUMO GERAL");
  if (logoId != null) wsResumo.addImage(logoId, { tl: { col: 0, row: 0 }, ext: { width: 160, height: 54 } });
  wsResumo.mergeCells("C1:F1");
  wsResumo.getCell("C1").value = "Saúde Completa da Carteira";
  wsResumo.getCell("C1").font = { bold: true, size: 16, color: { argb: AZUL } };
  wsResumo.getCell("C2").value = `Gerado em ${new Date().toLocaleString("pt-BR")}`;
  wsResumo.getCell("C2").font = { size: 10, color: { argb: "FF64748B" } };
  const cards = [
    ["Casos ativos", totais.casos_ativos], ["Alunos únicos", totais.cpfs_unicos],
    ["Saldo vencido", totais.saldo_vencido, true], ["Saldo total", totais.saldo_total, true],
    ["Nunca acionados", totais.nunca_acionados],
    [`Sem acionamento ≥ ${totais.min_dias_sem_acionamento || 5} dias`, totais.sem_acionamento_limite],
    ["% sem acionamento", totais.pct_sem_acionamento, false, true],
    ["Retornos vencidos", totais.retornos_vencidos], ["Sem telefone", totais.sem_telefone],
    ["Sem responsável", totais.sem_responsavel], ["Críticos", totais.criticos], ["Urgentes", totais.urgentes],
    ["Acordos em dia", totais.acordos_em_dia], ["Acordos vencidos", totais.acordos_vencidos],
    ["Acordos quebrados", totais.acordos_quebrados],
    ["Acordos em dia sem acompanhamento", totais.acordos_em_dia_sem_acompanhamento],
    ["Casos para revisão", totais.casos_revisao],
  ];
  let r = 4;
  wsResumo.getCell(`B${r}`).value = "Indicador";
  wsResumo.getCell(`C${r}`).value = "Valor";
  [`B${r}`, `C${r}`].forEach((a) => { wsResumo.getCell(a).font = { bold: true, color: { argb: "FFFFFFFF" } }; wsResumo.getCell(a).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } }; });
  r++;
  cards.forEach(([nome, val, money, pct]) => {
    wsResumo.getCell(`B${r}`).value = nome;
    const cell = wsResumo.getCell(`C${r}`);
    cell.value = Number(val || 0);
    if (money) cell.numFmt = 'R$ #,##0.00';
    if (pct) cell.numFmt = '0.0"%"';
    if (r % 2 === 0) [`B${r}`, `C${r}`].forEach((a) => (wsResumo.getCell(a).fill = { type: "pattern", pattern: "solid", fgColor: { argb: CINZA } }));
    r++;
  });
  wsResumo.getColumn(2).width = 34; wsResumo.getColumn(3).width = 20; wsResumo.getColumn(6).width = 22;

  // 2) POR ESTABELECIMENTO
  addAba(wb, "POR ESTABELECIMENTO", [
    { header: "Estabelecimento", key: "estabelecimento", width: 28 },
    { header: "Casos ativos", key: "casos_ativos" }, { header: "CPFs únicos", key: "cpfs_unicos" },
    { header: "Saldo vencido", key: "saldo_vencido", money: true }, { header: "Saldo total", key: "saldo_total", money: true },
    { header: "Nunca acionados", key: "nunca_acionados" }, { header: "Sem acionamento (limite)", key: "sem_acionamento_limite" },
    { header: "% sem acion.", key: "pct_sem_acionamento", pct: true }, { header: ">7d", key: "sem_ac_7" },
    { header: ">15d", key: "sem_ac_15" }, { header: ">30d", key: "sem_ac_30" },
    { header: "Retornos venc.", key: "retornos_vencidos" }, { header: "Sem telefone", key: "sem_telefone" },
    { header: "Sem responsável", key: "sem_responsavel" }, { header: "Críticos", key: "criticos" },
    { header: "Urgentes", key: "urgentes" }, { header: "Acordos em dia", key: "acordos_em_dia" },
    { header: "Acordos venc.", key: "acordos_vencidos" }, { header: "Acordos quebr.", key: "acordos_quebrados" },
    { header: "Revisão", key: "casos_revisao" },
  ], estabs);

  // 3) ESTABELECIMENTO X FAIXA
  addAba(wb, "ESTABELECIMENTO X FAIXA", [
    { header: "Estabelecimento", key: "estabelecimento", width: 28 },
    ...["a_vencer", "f1_30", "f31_60", "f61_90", "f91_180", "f181_365", "f_mais_365", "total"].map((k, i) => ({
      header: ["A vencer", "1-30", "31-60", "61-90", "91-180", "181-365", "365+", "Total"][i], key: k,
    })),
  ], mtxFaixa);

  // 4) TEMPO SEM ACIONAMENTO
  addAba(wb, "TEMPO SEM ACIONAMENTO", [
    { header: "Estabelecimento", key: "estabelecimento", width: 28 },
    ...["nunca", "d1", "d2_3", "d4_5", "d6_7", "d8_15", "d16_30", "d_mais_30", "total"].map((k, i) => ({
      header: ["Nunca", "1d", "2-3d", "4-5d", "6-7d", "8-15d", "16-30d", "30d+", "Total"][i], key: k,
    })),
  ], mtxTempo);

  // 5) POR OPERADOR
  addAba(wb, "POR OPERADOR", [
    { header: "Operador", key: "operador_email", width: 30 }, { header: "Casos", key: "casos_ativos" },
    { header: "CPFs únicos", key: "cpfs_unicos" }, { header: "Saldo vencido", key: "saldo_vencido", money: true },
    { header: "Saldo total", key: "saldo_total", money: true }, { header: "Nunca acion.", key: "nunca_acionados" },
    { header: "Sem acion. (limite)", key: "sem_acionamento_limite" }, { header: "% sem acion.", key: "pct_sem_acionamento", pct: true },
    { header: "Retornos venc.", key: "retornos_vencidos" }, { header: "Sem telefone", key: "sem_telefone" },
    { header: "Críticos", key: "criticos" }, { header: "Urgentes", key: "urgentes" },
    { header: "Acordos em dia", key: "acordos_em_dia" }, { header: "Acordos venc.", key: "acordos_vencidos" },
  ], operadores);

  // 6) DETALHAMENTO (mascarado)
  const colDet = [
    { header: "Estabelecimento", key: "estabelecimento", width: 26 }, { header: "Caso", key: "caso_codigo" },
    { header: "Aluno (masc.)", key: "aluno_mascarado", width: 18 }, { header: "Operador", key: "operador_email", width: 26 },
    { header: "Faixa atraso", key: "faixa_atraso" }, { header: "Dias atraso", key: "dias_atraso" },
    { header: "Parc. venc. + antiga", key: "parcela_vencida_mais_antiga", date: true }, { header: "Qtd tel.", key: "qtd_telefones" },
    { header: "Saldo vencido", key: "saldo_vencido", money: true }, { header: "Saldo total", key: "saldo_total", money: true },
    { header: "Acordo", key: "acordo_situacao" }, { header: "Criticidade", key: "criticidade" },
    { header: "Últ. acionamento", key: "ultimo_acionamento", date: true }, { header: "Dias s/ acion.", key: "dias_sem_acionamento" },
    { header: "Tipo últ. acion.", key: "tipo_ultimo_acionamento", width: 22 }, { header: "Próx. retorno", key: "proximo_retorno", date: true },
    { header: "Retorno venc.", key: "retorno_vencido" }, { header: "Próxima ação", key: "proxima_acao", width: 22 },
    { header: "Possui tel.", key: "possui_telefone" }, { header: "Situação oper.", key: "situacao_operacional", width: 22 },
    { header: "Últ. atualização", key: "ultima_atualizacao", date: true },
  ];
  const detFmt = detalhe.map((d) => ({
    ...d, faixa_atraso: FAIXA_ATRASO_LABEL[d.faixa_atraso] || d.faixa_atraso,
    retorno_vencido: d.retorno_vencido ? "Sim" : "Não", possui_telefone: d.possui_telefone ? "Sim" : "Não",
    parcela_vencida_mais_antiga: d.parcela_vencida_mais_antiga ? new Date(d.parcela_vencida_mais_antiga) : null,
    ultimo_acionamento: d.ultimo_acionamento ? new Date(d.ultimo_acionamento) : null,
    proximo_retorno: d.proximo_retorno ? new Date(d.proximo_retorno) : null,
    ultima_atualizacao: d.ultima_atualizacao ? new Date(d.ultima_atualizacao) : null,
  }));
  addAba(wb, "DETALHAMENTO", colDet, detFmt);

  // 7-12) recortes do detalhamento
  const recorte = (nome, filtro) => addAba(wb, nome, colDet, detFmt.filter(filtro));
  recorte("NUNCA ACIONADOS", (d) => d.dias_sem_acionamento == null);
  recorte("RETORNOS VENCIDOS", (d) => d.retorno_vencido === "Sim");
  recorte("SEM TELEFONE", (d) => d.possui_telefone === "Não");
  recorte("SEM RESPONSAVEL", (d) => !d.operador_email);
  recorte("ACORDOS EM DIA", (d) => d.acordo_situacao === "EM_DIA");
  recorte("ACORDOS VENCIDOS", (d) => d.acordo_situacao === "VENCIDO" || d.acordo_situacao === "QUEBRADO");

  // 13) QUALIDADE
  addAba(wb, "QUALIDADE", [{ header: "Inconsistência", key: "k", width: 34 }, { header: "Quantidade", key: "v" }],
    Object.entries(qualidade).map(([k, v]) => ({ k, v })));

  // 14) EXCLUSÕES
  addAba(wb, "EXCLUSOES", [{ header: "Regra de exclusão da carteira acionável", key: "k", width: 60 }],
    [["Casos encerrados (caso_encerrado_operacional): CANCELADO, JURIDICO, QUITADO/PAGO com saldo 0, saldo zero confirmado"],
     ["Quitados / cobrança cancelada / bloqueio jurídico"], ["Saldo em aberto igual a zero (títulos)"],
     ["Encerrados podem ser incluídos via filtro 'Incluir encerrados' (grupo separado)"]].map(([k]) => ({ k })));

  // 15) METODOLOGIA
  const metodo = [
    ["Data e hora", new Date().toLocaleString("pt-BR")],
    ["Filtros aplicados", JSON.stringify(filtrosAtivos || {})],
    ["Definição de caso", "1 linha por casos.id (public.casos)"],
    ["Definição de aluno único", "count(distinct aluno_id) — chave de pessoa deduplicada (dados de CPF de origem são sujos: mix de CPF e matrícula, só ~56% CPF 11 dígitos válido). Órfãos (aluno_id nulo) aparecem em Casos para revisão."],
    ["Acionamento válido", "casos.data_ultimo_acionamento (trigger fn_atualizar_ultimo_acionamento via eh_tipo_acionamento)"],
    ["Saldo vencido", "coluna persistida casos.saldo_vencido (recalcular_situacao_aluno)"],
    ["Saldo total", "coluna persistida casos.saldo_total"],
    ["Faixas de atraso", "A vencer / 1-30 / 31-60 / 61-90 / 91-180 / 181-365 / 365+ (dias)"],
    ["Faixas sem acionamento", "Nunca / 1 / 2-3 / 4-5 / 6-7 / 8-15 / 16-30 / 30+ dias"],
    ["Acordo", "derivado das parcelas: em dia (0 vencida) / vencido (>=1 vencida) / quebrado (vencida > 30 dias)"],
    ["Crítico/Urgente", "coluna criticidade com gate saldo_vencido > 0"],
    ["Exclusões", "caso_encerrado_operacional (encerrados/quitados/cancelados/jurídico/saldo zero)"],
    ["Fontes", "public.mv_saude_carteira (materialized) <- vw_saude_carteira <- casos+alunos+acordos+parcelas"],
    ["Mascaramento", "sem CPF ou telefone completos; apenas máscara e contagem de telefones"],
    ["Escopo", "gestão = global; operador = apenas própria carteira (forçado no backend)"],
  ];
  addAba(wb, "METODOLOGIA", [{ header: "Item", key: "k", width: 28 }, { header: "Descrição", key: "v", width: 90 }],
    metodo.map(([k, v]) => ({ k, v })));

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Saude_Carteira_${dataArquivo()}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================================
// Geracao dos relatorios Excel do Fechamento de Remuneracao (sintetico + analitico)
// Usa ExcelJS para embutir a logo oficial da Reativa, formato monetario BR,
// congelamento de paineis e configuracao de impressao.
// Uso EXCLUSIVO da Amanda (a tela ja e restrita). Nao envia a terceiros.
// ============================================================================
import ExcelJS from "exceljs";

const AZUL = "FF1E40AF";
const AZUL_CLARO = "FFDBEAFE";
const CINZA = "FFF3F4F6";
const FMT_MOEDA = '"R$" #,##0.00';
const FMT_PCT = '0.00"%"';
const FMT_DATA = "dd/mm/yyyy";

function nf(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function carregarLogoBase64() {
  try {
    const resp = await fetch("/logo_oficial_email.png");
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  } catch {
    return null;
  }
}

function estiloHeader(cell) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
  cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  cell.border = {
    top: { style: "thin", color: { argb: "FFBFDBFE" } },
    bottom: { style: "thin", color: { argb: "FFBFDBFE" } },
    left: { style: "thin", color: { argb: "FFBFDBFE" } },
    right: { style: "thin", color: { argb: "FFBFDBFE" } },
  };
}

// Cabecalho padrao (logo + titulo + metadados) no topo de uma aba
async function montarCabecalho(ws, wb, logoId, titulo, meta) {
  if (logoId != null) {
    ws.addImage(logoId, { tl: { col: 0, row: 0 }, ext: { width: 150, height: 55 } });
  }
  ws.getRow(1).height = 46;
  ws.mergeCells("C1:H1");
  const t = ws.getCell("C1");
  t.value = titulo;
  t.font = { bold: true, size: 16, color: { argb: AZUL } };
  t.alignment = { vertical: "middle", horizontal: "left" };

  const linhas = [
    `Competencia: ${meta.competencia}   |   Periodo: ${meta.periodo}`,
    `Versao: ${meta.versao}   |   Status: ${meta.status}`,
    `Gerado em: ${meta.geradoEm}   |   Gerado por: ${meta.geradoPor}`,
  ];
  linhas.forEach((txt, i) => {
    const r = 2 + i;
    ws.mergeCells(`C${r}:H${r}`);
    const c = ws.getCell(`C${r}`);
    c.value = txt;
    c.font = { size: 10, color: { argb: "FF374151" } };
  });
  return 6; // primeira linha de conteudo
}

function escreverTabela(ws, startRow, colunas, linhas, opts = {}) {
  const headerRow = ws.getRow(startRow);
  colunas.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.titulo;
    estiloHeader(cell);
    ws.getColumn(i + 1).width = col.largura || 16;
  });
  headerRow.height = 26;

  linhas.forEach((lin, idx) => {
    const r = ws.getRow(startRow + 1 + idx);
    colunas.forEach((col, i) => {
      const cell = r.getCell(i + 1);
      cell.value = col.valor(lin);
      if (col.fmt) cell.numFmt = col.fmt;
      if (col.align) cell.alignment = { horizontal: col.align };
      if (idx % 2 === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CINZA } };
      }
    });
  });

  if (opts.totais) {
    const r = ws.getRow(startRow + 1 + linhas.length);
    opts.totais.forEach((t, i) => {
      const cell = r.getCell(i + 1);
      cell.value = t.valor;
      if (t.fmt) cell.numFmt = t.fmt;
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL_CLARO } };
    });
  }

  ws.views = [{ state: "frozen", ySplit: startRow }];
  ws.pageSetup = {
    orientation: opts.orientacao || "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };
  ws.headerFooter = { oddFooter: `&L${opts.rodape || ""}&RPagina &P de &N` };
  return startRow + 1 + linhas.length;
}

// --------------------------------------------------------------------------
// RELATORIO SINTETICO
// --------------------------------------------------------------------------
export async function gerarExcelSintetico(previa, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "CRM Reativa - Fechamento de Remuneracao";
  const logoB64 = await carregarLogoBase64();
  const logoId = logoB64 != null ? wb.addImage({ base64: logoB64, extension: "png" }) : null;

  const benef = previa.beneficiarios || [];
  const totais = previa.totais || {};
  const fx = previa.faixas || {};
  const rodape = `Fechamento de Remuneracao - ${meta.competencia} - v${meta.versao} (${meta.status})`;

  // ---- RESUMO DA EQUIPE ----
  const wsResumo = wb.addWorksheet("RESUMO DA EQUIPE");
  let r = await montarCabecalho(wsResumo, wb, logoId, "Fechamento Mensal da Remuneracao", meta);
  const colsResumo = [
    { titulo: "Pos.", largura: 6, valor: (l, i) => l.__pos, align: "center" },
    { titulo: "Operador", largura: 24, valor: (l) => l.nome || l.email },
    { titulo: "E-mail", largura: 26, valor: (l) => l.email },
    { titulo: "Valor fixo", largura: 14, valor: (l) => nf(l.valor_fixo), fmt: FMT_MOEDA },
    { titulo: "Pagamentos", largura: 12, valor: (l) => nf(l.qtd_pagamentos), align: "center" },
    { titulo: "Valor recuperado", largura: 18, valor: (l) => nf(l.valor_recuperado), fmt: FMT_MOEDA },
    { titulo: "Honorarios", largura: 16, valor: (l) => nf(l.honorarios), fmt: FMT_MOEDA },
    { titulo: "Faixa", largura: 20, valor: (l) => l.faixa },
    { titulo: "%", largura: 8, valor: (l) => nf(l.percentual), fmt: FMT_PCT, align: "center" },
    { titulo: "Comissao", largura: 15, valor: (l) => (l.comissao == null ? "BLOQUEADO" : nf(l.comissao)), fmt: FMT_MOEDA },
    { titulo: "Premiacoes", largura: 14, valor: (l) => nf(l.premiacoes), fmt: FMT_MOEDA },
    { titulo: "Bonus/Correc.", largura: 14, valor: (l) => nf(l.bonus) + nf(l.correcoes), fmt: FMT_MOEDA },
    { titulo: "Descontos/Est.", largura: 14, valor: (l) => nf(l.descontos) + nf(l.estornos), fmt: FMT_MOEDA },
    { titulo: "TOTAL FINAL", largura: 16, valor: (l) => nf(l.total_final), fmt: FMT_MOEDA },
    { titulo: "Falta p/ faixa", largura: 14, valor: (l) => (l.falta_proxima_faixa == null ? "" : nf(l.falta_proxima_faixa)), fmt: FMT_MOEDA },
    { titulo: "Situacao", largura: 26, valor: (l) => l.situacao },
  ];
  const linhasResumo = benef
    .slice()
    .sort((a, b) => nf(b.total_final) - nf(a.total_final))
    .map((l, i) => ({ ...l, __pos: i + 1 }));
  escreverTabela(wsResumo, r, colsResumo, linhasResumo, {
    rodape,
    totais: [
      "TOTAIS", "", "",
      { valor: nf(totais.total_fixo), fmt: FMT_MOEDA },
      "",
      { valor: nf(totais.total_recuperado), fmt: FMT_MOEDA },
      { valor: nf(totais.total_honorario), fmt: FMT_MOEDA },
      "", "",
      { valor: nf(totais.total_comissao), fmt: FMT_MOEDA },
      { valor: nf(totais.total_premiacao), fmt: FMT_MOEDA },
      { valor: nf(totais.total_bonus) + nf(totais.total_correcoes), fmt: FMT_MOEDA },
      { valor: nf(totais.total_desconto) + nf(totais.total_estorno), fmt: FMT_MOEDA },
      { valor: nf(totais.total_final), fmt: FMT_MOEDA },
      "", "",
    ],
  });

  // ---- DEMONSTRATIVOS INDIVIDUAIS ----
  const wsDem = wb.addWorksheet("DEMONSTRATIVOS INDIVIDUAIS");
  await montarCabecalho(wsDem, wb, logoId, "Demonstrativos Individuais", meta);
  let dr = 7;
  wsDem.getColumn(1).width = 32;
  wsDem.getColumn(2).width = 24;
  linhasResumo.forEach((l) => {
    const put = (label, val, fmt) => {
      const row = wsDem.getRow(dr++);
      row.getCell(1).value = label;
      row.getCell(1).font = { bold: true, color: { argb: "FF374151" } };
      const c = row.getCell(2);
      c.value = val;
      if (fmt) c.numFmt = fmt;
      return c;
    };
    const tit = wsDem.getRow(dr++);
    wsDem.mergeCells(`A${tit.number}:D${tit.number}`);
    tit.getCell(1).value = `${l.nome || l.email}  (${l.email})`;
    tit.getCell(1).font = { bold: true, size: 13, color: { argb: AZUL } };
    put(l.nome_exibicao_fixo || "Valor fixo contratual", nf(l.valor_fixo), FMT_MOEDA);
    put("Producao recuperada", nf(l.valor_recuperado), FMT_MOEDA);
    put("Honorarios produzidos", nf(l.honorarios), FMT_MOEDA);
    put("Faixa atingida", l.faixa);
    put("Percentual aplicado", nf(l.percentual), FMT_PCT);
    const mem = wsDem.getRow(dr++);
    mem.getCell(1).value = "Memoria do calculo";
    mem.getCell(1).font = { bold: true, color: { argb: "FF374151" } };
    mem.getCell(2).value =
      l.comissao == null
        ? "Comissao bloqueada: faixas nao configuradas"
        : `Honorarios de R$ ${nf(l.honorarios).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} x ${nf(l.percentual)}% = comissao de R$ ${nf(l.comissao).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
    put("Comissao", l.comissao == null ? 0 : nf(l.comissao), FMT_MOEDA);
    put("Premiacoes", nf(l.premiacoes), FMT_MOEDA);
    put("Bonus", nf(l.bonus), FMT_MOEDA);
    put("Correcoes", nf(l.correcoes), FMT_MOEDA);
    put("Descontos", nf(l.descontos), FMT_MOEDA);
    put("Estornos", nf(l.estornos), FMT_MOEDA);
    const tf = wsDem.getRow(dr++);
    tf.getCell(1).value = "TOTAL FINAL A RECEBER";
    tf.getCell(1).font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
    tf.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
    tf.getCell(2).value = nf(l.total_final);
    tf.getCell(2).numFmt = FMT_MOEDA;
    tf.getCell(2).font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
    tf.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
    dr++; // espaco
  });
  wsDem.pageSetup = { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  // ---- FAIXAS UTILIZADAS ----
  const wsFx = wb.addWorksheet("FAIXAS UTILIZADAS");
  const fr = await montarCabecalho(wsFx, wb, logoId, "Faixas de Comissao Utilizadas", meta);
  escreverTabela(
    wsFx, fr,
    [
      { titulo: "Faixa", largura: 12, valor: (l) => l.faixa },
      { titulo: "Valor inicial", largura: 16, valor: (l) => nf(l.ini), fmt: FMT_MOEDA },
      { titulo: "Percentual", largura: 14, valor: (l) => nf(l.pct), fmt: FMT_PCT, align: "center" },
      { titulo: "Origem", largura: 20, valor: () => "metas_projecao" },
    ],
    [
      { faixa: "Faixa 1", ini: fx.m1_valor, pct: fx.m1_percentual },
      { faixa: "Faixa 2", ini: fx.m2_valor, pct: fx.m2_percentual },
      { faixa: "Faixa 3", ini: fx.m3_valor, pct: fx.m3_percentual },
      { faixa: "Faixa 4", ini: fx.m4_valor, pct: fx.m4_percentual },
    ],
    { rodape, orientacao: "portrait" }
  );

  // ---- PREMIACOES ----
  await abaLancamentos(wb, logoId, meta, "PREMIACOES", (previa.__premiacoes || []), [
    { titulo: "Beneficiario", largura: 24, valor: (l) => l.beneficiario_nome || l.beneficiario_email },
    { titulo: "Tipo", largura: 18, valor: (l) => l.tipo },
    { titulo: "Campanha", largura: 22, valor: (l) => l.nome_campanha || "" },
    { titulo: "Criterio", largura: 24, valor: (l) => l.criterio || "" },
    { titulo: "Valor", largura: 14, valor: (l) => nf(l.valor), fmt: FMT_MOEDA },
    { titulo: "Origem", largura: 18, valor: (l) => l.origem || "" },
  ], rodape);

  // ---- AJUSTES E DESCONTOS ----
  await abaLancamentos(wb, logoId, meta, "AJUSTES E DESCONTOS", (previa.__ajustes || []), [
    { titulo: "Beneficiario", largura: 24, valor: (l) => l.beneficiario_nome || l.beneficiario_email },
    { titulo: "Tipo", largura: 18, valor: (l) => l.tipo },
    { titulo: "Natureza", largura: 12, valor: (l) => l.natureza },
    { titulo: "Valor", largura: 14, valor: (l) => nf(l.valor), fmt: FMT_MOEDA },
    { titulo: "Motivo", largura: 32, valor: (l) => l.motivo },
    { titulo: "Documento", largura: 18, valor: (l) => l.documento_ref || "" },
  ], rodape);

  // ---- SEM OPERADOR ----
  const wsSem = wb.addWorksheet("SEM OPERADOR");
  const sr = await montarCabecalho(wsSem, wb, logoId, "Pagamentos sem Operador", meta);
  const sem = previa.sem_operador || {};
  escreverTabela(
    wsSem, sr,
    [
      { titulo: "Quantidade", largura: 14, valor: (l) => nf(l.qtd), align: "center" },
      { titulo: "Valor recuperado", largura: 18, valor: (l) => nf(l.valor_recuperado), fmt: FMT_MOEDA },
      { titulo: "Honorarios", largura: 16, valor: (l) => nf(l.honorarios), fmt: FMT_MOEDA },
      { titulo: "Motivo", largura: 40, valor: (l) => l.motivo },
    ],
    [sem],
    { rodape, orientacao: "portrait" }
  );

  // ---- TOTAIS DO FECHAMENTO ----
  const wsTot = wb.addWorksheet("TOTAIS DO FECHAMENTO");
  let tr = await montarCabecalho(wsTot, wb, logoId, "Totais do Fechamento", meta);
  const pares = [
    ["Total fixo da equipe", nf(totais.total_fixo)],
    ["Total recuperado", nf(totais.total_recuperado)],
    ["Total de honorarios", nf(totais.total_honorario)],
    ["Total de comissoes", nf(totais.total_comissao)],
    ["Total de premiacoes", nf(totais.total_premiacao)],
    ["Total de bonus", nf(totais.total_bonus)],
    ["Total de correcoes", nf(totais.total_correcoes)],
    ["Total de descontos", nf(totais.total_desconto)],
    ["Total de estornos", nf(totais.total_estorno)],
    ["TOTAL FINAL DA FOLHA", nf(totais.total_final)],
    ["Valor sem operador", nf(totais.valor_sem_operador)],
    ["Registros sem operador", nf(totais.qtd_sem_operador)],
  ];
  wsTot.getColumn(1).width = 30;
  wsTot.getColumn(2).width = 20;
  pares.forEach(([k, v], i) => {
    const row = wsTot.getRow(tr + i);
    row.getCell(1).value = k;
    const c = row.getCell(2);
    c.value = v;
    if (k !== "Registros sem operador") c.numFmt = FMT_MOEDA;
    if (k.startsWith("TOTAL FINAL")) {
      row.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      row.getCell(1).fill = c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
    }
  });

  // ---- AUDITORIA ----
  abaAuditoria(wb, logoId, meta, previa);

  return await wb.xlsx.writeBuffer();
}

async function abaLancamentos(wb, logoId, meta, nome, dados, colunas, rodape) {
  const ws = wb.addWorksheet(nome);
  const r = await montarCabecalho(ws, wb, logoId, nome, meta);
  escreverTabela(ws, r, colunas, dados || [], { rodape });
}

async function abaAuditoria(wb, logoId, meta, previa) {
  const ws = wb.addWorksheet("AUDITORIA");
  let r = await montarCabecalho(ws, wb, logoId, "Auditoria do Fechamento", meta);
  const recon = previa.reconciliacao || {};
  const linhas = [
    ["Competencia", meta.competencia],
    ["Periodo", meta.periodo],
    ["Versao", String(meta.versao)],
    ["Status", meta.status],
    ["Gerado em", meta.geradoEm],
    ["Gerado por", meta.geradoPor],
    ["Faixas configuradas", previa.faixas_configuradas ? "SIM" : "NAO"],
    ["Reconciliacao OK", recon.ok ? "SIM (R$ 0,00)" : "NAO"],
    ["Diferenca recuperado", `R$ ${nf(recon.diff_recuperado).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`],
    ["Diferenca honorarios", `R$ ${nf(recon.diff_honorario).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`],
    ["Projecao recuperado", `R$ ${nf(recon.projecao_recuperado).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`],
    ["Fechamento recuperado", `R$ ${nf(recon.fechamento_recuperado_total).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`],
  ];
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 40;
  linhas.forEach(([k, v], i) => {
    const row = ws.getRow(r + i);
    row.getCell(1).value = k;
    row.getCell(1).font = { bold: true, color: { argb: "FF374151" } };
    row.getCell(2).value = v;
  });
}

// --------------------------------------------------------------------------
// RELATORIO ANALITICO
// --------------------------------------------------------------------------
export async function gerarExcelAnalitico(previa, analitico, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "CRM Reativa - Fechamento de Remuneracao";
  const logoB64 = await carregarLogoBase64();
  const logoId = logoB64 != null ? wb.addImage({ base64: logoB64, extension: "png" }) : null;
  const rodape = `Analitico ${meta.competencia} v${meta.versao} (${meta.status})`;
  const pagtos = analitico || [];

  // PAGAMENTOS
  const wsPg = wb.addWorksheet("PAGAMENTOS");
  const pr = await montarCabecalho(wsPg, wb, logoId, "Analitico - Pagamentos", meta);
  escreverTabela(wsPg, pr, [
    { titulo: "Data pagamento", largura: 15, valor: (l) => (l.data_pagamento ? new Date(l.data_pagamento + "T00:00:00") : ""), fmt: FMT_DATA, align: "center" },
    { titulo: "ID pagamento", largura: 20, valor: (l) => l.pagamento_id },
    { titulo: "Lote (import)", largura: 20, valor: (l) => l.importacao_id || "" },
    { titulo: "Aluno (masc.)", largura: 22, valor: (l) => l.aluno_mascarado },
    { titulo: "Operador", largura: 22, valor: (l) => l.operador_nome || "" },
    { titulo: "E-mail operador", largura: 24, valor: (l) => l.operador_email || "SEM OPERADOR" },
    { titulo: "Tipo", largura: 14, valor: (l) => l.tipo_pagamento || "" },
    { titulo: "Parcela", largura: 16, valor: (l) => l.numero_parcela || "" },
    { titulo: "Valor recuperado", largura: 16, valor: (l) => nf(l.valor_recuperado), fmt: FMT_MOEDA },
    { titulo: "Honorarios", largura: 14, valor: (l) => nf(l.honorarios), fmt: FMT_MOEDA },
    { titulo: "Elegivel comissao", largura: 14, valor: (l) => (l.elegivel_comissao ? "SIM" : "NAO"), align: "center" },
    { titulo: "Motivo exclusao", largura: 18, valor: (l) => l.motivo_exclusao || "" },
    { titulo: "Retroativo", largura: 10, valor: (l) => (l.retroativo ? "SIM" : "NAO"), align: "center" },
  ], pagtos, { rodape });

  // RESUMO POR OPERADOR
  const wsRo = wb.addWorksheet("RESUMO POR OPERADOR");
  const ror = await montarCabecalho(wsRo, wb, logoId, "Resumo por Operador", meta);
  escreverTabela(wsRo, ror, [
    { titulo: "Operador", largura: 24, valor: (l) => l.nome || l.email },
    { titulo: "E-mail", largura: 26, valor: (l) => l.email },
    { titulo: "Pagamentos", largura: 12, valor: (l) => nf(l.qtd_pagamentos), align: "center" },
    { titulo: "Valor recuperado", largura: 18, valor: (l) => nf(l.valor_recuperado), fmt: FMT_MOEDA },
    { titulo: "Honorarios", largura: 16, valor: (l) => nf(l.honorarios), fmt: FMT_MOEDA },
    { titulo: "%", largura: 8, valor: (l) => nf(l.percentual), fmt: FMT_PCT, align: "center" },
    { titulo: "Comissao", largura: 15, valor: (l) => nf(l.comissao), fmt: FMT_MOEDA },
  ], (previa.beneficiarios || []), { rodape, orientacao: "portrait" });

  // MEMORIA DAS COMISSOES
  const wsMc = wb.addWorksheet("MEMORIA DAS COMISSOES");
  const mcr = await montarCabecalho(wsMc, wb, logoId, "Memoria das Comissoes", meta);
  escreverTabela(wsMc, mcr, [
    { titulo: "Operador", largura: 24, valor: (l) => l.nome || l.email },
    { titulo: "Honorarios", largura: 16, valor: (l) => nf(l.honorarios), fmt: FMT_MOEDA },
    { titulo: "Faixa", largura: 20, valor: (l) => l.faixa },
    { titulo: "%", largura: 8, valor: (l) => nf(l.percentual), fmt: FMT_PCT, align: "center" },
    { titulo: "Memoria", largura: 50, valor: (l) => (l.comissao == null ? "BLOQUEADO" : `${nf(l.honorarios).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} x ${nf(l.percentual)}% = ${nf(l.comissao).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`) },
  ], (previa.beneficiarios || []), { rodape });

  // MEMORIA DAS PREMIACOES
  await abaLancamentos(wb, logoId, meta, "MEMORIA DAS PREMIACOES", (previa.__premiacoes || []), [
    { titulo: "Beneficiario", largura: 24, valor: (l) => l.beneficiario_nome || l.beneficiario_email },
    { titulo: "Tipo", largura: 18, valor: (l) => l.tipo },
    { titulo: "Campanha", largura: 22, valor: (l) => l.nome_campanha || "" },
    { titulo: "Valor", largura: 14, valor: (l) => nf(l.valor), fmt: FMT_MOEDA },
  ], rodape);

  // AJUSTES
  await abaLancamentos(wb, logoId, meta, "AJUSTES", (previa.__ajustes || []), [
    { titulo: "Beneficiario", largura: 24, valor: (l) => l.beneficiario_nome || l.beneficiario_email },
    { titulo: "Tipo", largura: 18, valor: (l) => l.tipo },
    { titulo: "Natureza", largura: 12, valor: (l) => l.natureza },
    { titulo: "Valor", largura: 14, valor: (l) => nf(l.valor), fmt: FMT_MOEDA },
    { titulo: "Motivo", largura: 32, valor: (l) => l.motivo },
  ], rodape);

  // EXCLUSOES (pagamentos sem operador)
  const wsEx = wb.addWorksheet("EXCLUSOES");
  const exr = await montarCabecalho(wsEx, wb, logoId, "Exclusoes", meta);
  escreverTabela(wsEx, exr, [
    { titulo: "ID pagamento", largura: 20, valor: (l) => l.pagamento_id },
    { titulo: "Data", largura: 15, valor: (l) => (l.data_pagamento ? new Date(l.data_pagamento + "T00:00:00") : ""), fmt: FMT_DATA },
    { titulo: "Valor recuperado", largura: 16, valor: (l) => nf(l.valor_recuperado), fmt: FMT_MOEDA },
    { titulo: "Honorarios", largura: 14, valor: (l) => nf(l.honorarios), fmt: FMT_MOEDA },
    { titulo: "Motivo exclusao", largura: 24, valor: (l) => l.motivo_exclusao },
  ], (pagtos.filter((p) => p.motivo_exclusao)), { rodape });

  // DIVERGENCIAS
  const wsDv = wb.addWorksheet("DIVERGENCIAS");
  const dvr = await montarCabecalho(wsDv, wb, logoId, "Divergencias (Analitico x Projecao)", meta);
  const recon = previa.reconciliacao || {};
  escreverTabela(wsDv, dvr, [
    { titulo: "Indicador", largura: 26, valor: (l) => l.k },
    { titulo: "Fechamento", largura: 20, valor: (l) => nf(l.f), fmt: FMT_MOEDA },
    { titulo: "Projecao", largura: 20, valor: (l) => nf(l.p), fmt: FMT_MOEDA },
    { titulo: "Diferenca", largura: 18, valor: (l) => nf(l.d), fmt: FMT_MOEDA },
  ], [
    { k: "Valor recuperado", f: recon.fechamento_recuperado_total, p: recon.projecao_recuperado, d: recon.diff_recuperado },
    { k: "Honorarios", f: recon.fechamento_honorario_total, p: recon.projecao_honorario, d: recon.diff_honorario },
  ], { rodape, orientacao: "portrait" });

  // SEM OPERADOR
  const wsSo = wb.addWorksheet("SEM OPERADOR");
  const sor = await montarCabecalho(wsSo, wb, logoId, "Sem Operador", meta);
  const sem = previa.sem_operador || {};
  escreverTabela(wsSo, sor, [
    { titulo: "Quantidade", largura: 14, valor: (l) => nf(l.qtd), align: "center" },
    { titulo: "Valor recuperado", largura: 18, valor: (l) => nf(l.valor_recuperado), fmt: FMT_MOEDA },
    { titulo: "Honorarios", largura: 16, valor: (l) => nf(l.honorarios), fmt: FMT_MOEDA },
    { titulo: "Motivo", largura: 40, valor: (l) => l.motivo },
  ], [sem], { rodape, orientacao: "portrait" });

  // AUDITORIA
  await abaAuditoria(wb, logoId, meta, previa);

  return await wb.xlsx.writeBuffer();
}

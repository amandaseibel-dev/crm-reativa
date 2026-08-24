// PDF do relatório "Pagamentos por Operador e Vencimento" (Projeção, só gestão).
// Mesma fonte do Excel (buscarPagamentosVencimento); visual segue o padrão do
// PDF da Projeção Hora a Hora (jsPDF direto, sem autotable).
import { jsPDF } from "jspdf";
import { buscarPagamentosVencimento, ROTULO_SITUACAO_VENCIMENTO } from "./relatoriosProjecaoExcel";
import { OPERADORES_POR_EMAIL } from "./operadores";

const BR = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const N = (v) => (Number(v) || 0).toLocaleString("pt-BR");
const DBR = (iso) => { if (!iso) return "-"; const [a, m, d] = String(iso).slice(0, 10).split("-"); return `${d}/${m}/${a}`; };

function nomeOp(item) {
  if (item.operador_email === "SEM_OPERADOR") {
    return item.operador_nome && item.operador_nome !== "Sem operador"
      ? `Sem operador (${item.operador_nome})` : "Sem operador";
  }
  return OPERADORES_POR_EMAIL[String(item.operador_email || "").toLowerCase()] || item.operador_nome || item.operador_email || "-";
}

export async function exportarPagamentosVencimentoPdf(mes, filtros = {}) {
  const { itens, resumoOperador } = await buscarPagamentosVencimento(mes, filtros);

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const PW = 595.28, PH = 841.89, M = 40, CW = PW - 2 * M;
  const BLUE = [37, 99, 235], INK = [31, 41, 55], MUT = [107, 114, 128], LINE = [229, 231, 235], SOFT = [244, 246, 250], SOFTBLUE = [232, 238, 246];
  let y = 0;
  const need = (h) => { if (y + h > PH - 46) { doc.addPage(); y = 48; } };

  doc.setFillColor(...BLUE); doc.rect(0, 0, PW, 5, "F");
  y = 46;
  doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(...INK);
  doc.text(`Pagamentos por Operador e Vencimento — ${mes}`, M, y);
  y += 14;
  const partesFiltro = [];
  partesFiltro.push(filtros.operadores && filtros.operadores.length
    ? `Operadores: ${filtros.operadores.length} selecionado(s)` : "Operadores: todos");
  if (filtros.vencDe || filtros.vencAte) partesFiltro.push(`Vencimento: ${DBR(filtros.vencDe) || "início"} a ${DBR(filtros.vencAte) || "fim"}`);
  else partesFiltro.push("Vencimento: todos");
  if (filtros.incluirSemVencimento === false) partesFiltro.push("sem vencimento excluídos");
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUT);
  doc.text(partesFiltro.join("  ·  "), M, y);
  y += 22;

  // KPIs
  const somaPago = itens.reduce((s, i) => s + (Number(i.valor_pago) || 0), 0);
  const somaHon = itens.reduce((s, i) => s + (Number(i.valor_honorario) || 0), 0);
  const qtdAtraso = itens.filter((i) => i.situacao === "ATRASADO").length;
  const kpis = [["PAGAMENTOS", N(itens.length)], ["RECUPERADO", BR(somaPago)], ["HONORÁRIOS", BR(somaHon)], ["PAGOS EM ATRASO", N(qtdAtraso)]];
  const gap = 10, kw = (CW - 3 * gap) / 4, kh = 54;
  kpis.forEach((k, i) => {
    const x = M + i * (kw + gap);
    doc.setFillColor(...(i === 0 ? SOFTBLUE : SOFT)); doc.roundedRect(x, y, kw, kh, 7, 7, "F");
    doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...MUT); doc.text(k[0], x + 10, y + 17);
    doc.setFont("helvetica", "bold"); doc.setFontSize(k[1].length > 12 ? 11 : 14); doc.setTextColor(...INK); doc.text(k[1], x + 10, y + 38);
  });
  y += kh + 26;

  // Tabela genérica com larguras por coluna (frações de CW).
  const tabela = (titulo, cabec, linhas, fracoes, aligns) => {
    if (!linhas.length) return;
    need(50);
    doc.setFillColor(...BLUE); doc.rect(M, y - 9, 3, 13, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...INK); doc.text(titulo, M + 10, y); y += 10;
    const xs = []; let acc = M;
    fracoes.forEach((f) => { xs.push(acc); acc += f * CW; });
    const colX = (i) => (aligns[i] === "right" ? xs[i] + fracoes[i] * CW - 6 : xs[i] + 6);
    doc.setFillColor(...SOFT); doc.rect(M, y, CW, 18, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(...MUT);
    cabec.forEach((c, i) => doc.text(c, colX(i), y + 12, { align: aligns[i] })); y += 18;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...INK);
    linhas.forEach((l, r) => {
      need(15); if (r % 2 === 1) { doc.setFillColor(...SOFT); doc.rect(M, y, CW, 14, "F"); }
      l.forEach((cel, i) => {
        const s = doc.splitTextToSize(String(cel ?? ""), fracoes[i] * CW - 10)[0] || "";
        doc.text(s, colX(i), y + 10, { align: aligns[i] });
      });
      y += 14;
    });
    y += 20;
  };

  tabela(
    "Resumo por operador",
    ["Operador", "Qtd", "Em dia", "Adiant.", "Atras.", "Sem venc.", "Recuperado", "Honorário"],
    (resumoOperador || []).map((r) => [
      nomeOp(r), N(r.qtd), N(r.qtd_em_dia), N(r.qtd_adiantado), N(r.qtd_atrasado), N(r.qtd_sem_vencimento),
      BR(r.soma_pago), BR(r.soma_honorario),
    ]),
    [0.24, 0.07, 0.08, 0.08, 0.08, 0.09, 0.18, 0.18],
    ["left", "right", "right", "right", "right", "right", "right", "right"]
  );

  tabela(
    "Pagamentos",
    ["Operador", "Aluno", "Venc.", "Pagto", "Situação", "Recuperado", "Honorário"],
    itens.map((p) => [
      nomeOp(p), p.aluno_nome || "-", DBR(p.vencimento), DBR(p.data_pagamento),
      ROTULO_SITUACAO_VENCIMENTO[p.situacao] || p.situacao || "-",
      BR(p.valor_pago), BR(p.valor_honorario),
    ]),
    [0.16, 0.28, 0.09, 0.09, 0.11, 0.14, 0.13],
    ["left", "left", "left", "left", "left", "right", "right"]
  );

  // rodapé com paginação
  const pgs = doc.getNumberOfPages();
  for (let p = 1; p <= pgs; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...MUT);
    doc.text(`ReATIVA · Projeção ${mes} · página ${p}/${pgs}`, PW / 2, PH - 20, { align: "center" });
  }

  const sufixoVenc = filtros.vencDe || filtros.vencAte
    ? `_venc_${filtros.vencDe || "inicio"}_a_${filtros.vencAte || "fim"}` : "";
  doc.save(`Relatorio_Vencimento_Reativa_${mes}${sufixoVenc}.pdf`);
}

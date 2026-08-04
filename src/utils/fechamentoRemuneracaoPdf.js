// ============================================================================
// PDF de Remuneracao — UM POR OPERADOR (padrao ReATIVA)
// Gera um demonstrativo individual: cabecalho com logo, resumo (Recuperado /
// Faixa de remuneracao / Comissao / Total), a "visao das metas de referencia
// do mes" (as faixas de comissao, destacando a faixa atual do operador) e a
// composicao completa do total. Um arquivo PDF por operador.
//
// Uso:
//   import { gerarPdfOperador, gerarPdfsTodos } from ".../fechamentoRemuneracaoPdf";
//   await gerarPdfOperador(benef, previa, "2026-07");   // um operador
//   await gerarPdfsTodos(previa, "2026-07");            // todos, em sequencia
// ============================================================================
import jsPDF from "jspdf";

const BR = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const PCT = (v) => `${Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

function nomeMes(mes) {
  const [an, me] = String(mes).split("-");
  const nomes = ["", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  return `${nomes[Number(me)] || me}/${an}`;
}

async function carregarLogo() {
  try {
    const resp = await fetch("/logo_padrao_email.png");
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => res(null);
      fr.readAsDataURL(blob);
    });
  } catch { return null; }
}

// Deriva as faixas configuradas (m1..m4) num array ordenado, so as que existem.
function faixasDoMes(previa) {
  const f = previa?.faixas || {};
  const out = [];
  for (let i = 1; i <= 4; i++) {
    const valor = Number(f[`m${i}_valor`] || 0);
    const pct = Number(f[`m${i}_percentual`] || 0);
    if (valor > 0 || pct > 0) out.push({ n: i, valor, pct });
  }
  return out;
}

// Indice (1..4) da faixa atual do operador, pelo honorario alcancado.
function faixaAtualDoOperador(faixas, honorario) {
  let atual = 0;
  for (const fx of faixas) if (Number(honorario) >= fx.valor) atual = fx.n;
  return atual;
}

// Desenha um demonstrativo de UM operador em `doc` (assume pagina ja pronta).
function desenharOperador(doc, benef, previa, mes, logo) {
  const PW = 595.28, PH = 841.89, M = 40, CW = PW - 2 * M;
  const BLUE = [37, 99, 235], INK = [31, 41, 55], MUT = [107, 114, 128],
    LINE = [229, 231, 235], SOFT = [244, 246, 250], SOFTBLUE = [232, 238, 246];
  let y = 0;
  const need = (h) => { if (y + h > PH - 46) { doc.addPage(); y = 48; } };

  doc.setFillColor(...BLUE); doc.rect(0, 0, PW, 5, "F");
  y = 30;
  let lh = 0;
  if (logo) { const lw = 128; lh = (128 * 150) / 356; try { doc.addImage(logo, "PNG", M, y, lw, lh); } catch { /* sem logo */ } }
  y += (lh || 40) + 16;

  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(...INK);
  doc.text("Demonstrativo de Remuneração · " + nomeMes(mes), M, y);
  y += 16;
  doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...BLUE);
  doc.text(String(benef.nome || benef.email || "-"), M, y);
  y += 22;

  // --- Resumo: HONORÁRIOS em destaque (o que importa aqui) / Faixa / Comissão / Total ---
  const kpis = [
    ["HONORÁRIOS", BR(benef.honorarios)],
    ["FAIXA DE REMUNERAÇÃO", String(benef.faixa || "-")],
    ["COMISSÃO", benef.comissao == null ? "—" : BR(benef.comissao)],
    ["TOTAL", BR(benef.total_final)],
  ];
  const gap = 10, kw = (CW - 3 * gap) / 4, kh = 58;
  kpis.forEach((k, i) => {
    const x = M + i * (kw + gap);
    const destaque = i === 0 || i === 3; // honorários e total
    doc.setFillColor(...(destaque ? SOFTBLUE : SOFT)); doc.roundedRect(x, y, kw, kh, 7, 7, "F");
    if (i === 0) { doc.setDrawColor(...BLUE); doc.setLineWidth(1.2); doc.roundedRect(x, y, kw, kh, 7, 7, "S"); doc.setLineWidth(0.2); }
    doc.setFont("helvetica", "bold"); doc.setFontSize(6.5); doc.setTextColor(...(i === 0 ? BLUE : MUT));
    doc.text(k[0], x + 9, y + 15);
    const val = doc.splitTextToSize(k[1], kw - 16);
    doc.setFont("helvetica", "bold"); doc.setFontSize(val[0].length > 14 ? 9.5 : (i === 0 ? 14 : 12.5)); doc.setTextColor(...INK);
    doc.text(val[0], x + 9, y + 36);
    if (val[1]) { doc.setFontSize(8); doc.text(val[1], x + 9, y + 48); }
  });
  y += kh + 24;

  // --- Metas de referencia do mes (a parte da operacao) ---
  const faixas = faixasDoMes(previa);
  const ehGestao = String(benef.regra_comissao || "") === "percentual_total_honorario";
  doc.setFillColor(...BLUE); doc.rect(M, y - 9, 3, 13, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...INK);
  doc.text("Metas de referência do mês", M + 10, y); y += 8;
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...MUT);

  if (ehGestao) {
    y += 12;
    doc.text("Remuneração da gestão: " + PCT(benef.percentual) + " sobre o honorário total da empresa no mês.", M + 2, y);
    y += 13;
    doc.text("Honorário total da empresa no mês (base): " + BR(benef.honorarios), M + 2, y);
    y += 20;
  } else if (!faixas.length) {
    y += 12;
    doc.text("Faixas de comissão não configuradas para este mês.", M + 2, y);
    y += 20;
  } else {
    const atual = faixaAtualDoOperador(faixas, benef.honorarios);
    y += 6;
    // Cabecalho da tabela de faixas
    const col = [M + 8, M + 150, M + 320, M + 470];
    doc.setFillColor(...SOFT); doc.rect(M, y, CW, 18, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(...MUT);
    doc.text("FAIXA", col[0], y + 12);
    doc.text("HONORÁRIO A PARTIR DE", col[1], y + 12);
    doc.text("% COMISSÃO", col[2], y + 12);
    doc.text("SITUAÇÃO", col[3], y + 12);
    y += 18;
    faixas.forEach((fx) => {
      need(16);
      const ativa = fx.n === atual;
      if (ativa) { doc.setFillColor(...SOFTBLUE); doc.rect(M, y, CW, 16, "F"); }
      doc.setFont("helvetica", ativa ? "bold" : "normal"); doc.setFontSize(9); doc.setTextColor(...INK);
      doc.text("Faixa " + fx.n, col[0], y + 11);
      doc.text("≥ " + BR(fx.valor), col[1], y + 11);
      doc.text(PCT(fx.pct), col[2], y + 11);
      doc.setTextColor(...(ativa ? BLUE : MUT));
      doc.text(ativa ? "◄ faixa atual" : "", col[3], y + 11);
      y += 16;
    });
    y += 12;
    // Honorario do operador + falta p/ proxima faixa
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...INK);
    doc.text("Seu honorário no mês: " + BR(benef.honorarios), M + 2, y); y += 13;
    if (benef.falta_proxima_faixa != null && Number(benef.falta_proxima_faixa) > 0) {
      doc.setTextColor(...BLUE);
      doc.text("Faltam " + BR(benef.falta_proxima_faixa) + " em honorário para subir de faixa.", M + 2, y);
      y += 13;
    } else {
      doc.setTextColor(...MUT);
      doc.text("Você está na faixa máxima atingível com o honorário do mês.", M + 2, y);
      y += 13;
    }
    y += 8;
  }

  // Rodape
  doc.setDrawColor(...LINE); doc.line(M, PH - 34, PW - M, PH - 34);
  doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...MUT);
  doc.text("ReATIVA · Demonstrativo de Remuneração · " + nomeMes(mes), M, PH - 15);
  doc.text("Gerado em " + new Date().toLocaleString("pt-BR"), PW - M, PH - 15, { align: "right" });
}

function nomeArquivo(benef, mes) {
  const base = String(benef.nome || benef.email || "operador")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase();
  return `remuneracao_${base}_${mes}.pdf`;
}

// Um PDF para UM operador.
export async function gerarPdfOperador(benef, previa, mes, logoCache) {
  const logo = logoCache !== undefined ? logoCache : await carregarLogo();
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  desenharOperador(doc, benef, previa, mes, logo);
  doc.save(nomeArquivo(benef, mes));
}

// Um PDF por operador, para TODOS os beneficiarios (em sequencia).
export async function gerarPdfsTodos(previa, mes) {
  const benef = (previa?.beneficiarios || []).slice()
    .sort((a, b) => Number(b.total_final) - Number(a.total_final));
  if (!benef.length) return 0;
  const logo = await carregarLogo();
  for (const b of benef) {
    await gerarPdfOperador(b, previa, mes, logo);
    // pequeno respiro entre downloads para o navegador nao bloquear
    await new Promise((r) => setTimeout(r, 350));
  }
  return benef.length;
}

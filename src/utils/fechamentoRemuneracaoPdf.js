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
import { jsPDF } from "jspdf";

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
  const DEEP = [30, 58, 138]; // azul escuro p/ header

  // ---- Header: faixa azul escura com logo + competência ----
  const headH = 78;
  doc.setFillColor(...DEEP); doc.rect(0, 0, PW, headH, "F");
  doc.setFillColor(...BLUE); doc.rect(0, headH, PW, 3, "F");
  if (logo) { const lw = 116, lhh = (116 * 150) / 356; try { doc.addImage(logo, "PNG", M, (headH - lhh) / 2, lw, lhh); } catch { /* sem logo */ } }
  // pill competência (à direita)
  const comp = nomeMes(mes);
  doc.setFont("helvetica", "bold"); doc.setFontSize(9);
  const cpw = doc.getTextWidth(comp.toUpperCase()) + 24;
  doc.setFillColor(255, 255, 255); doc.roundedRect(PW - M - cpw, headH / 2 - 11, cpw, 22, 11, 11, "F");
  doc.setTextColor(...DEEP); doc.text(comp.toUpperCase(), PW - M - cpw / 2, headH / 2 + 3.5, { align: "center" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(210, 221, 245);
  doc.text("Demonstrativo de Remuneração", PW - M, headH / 2 + 18, { align: "right" });
  y = headH + 26;

  // ---- Nome do operador + pill da faixa ----
  doc.setFont("helvetica", "bold"); doc.setFontSize(19); doc.setTextColor(...INK);
  doc.text(String(benef.nome || benef.email || "-"), M, y);
  {
    const ftxt = String(benef.faixa || "-");
    doc.setFont("helvetica", "bold"); doc.setFontSize(8.5);
    const fpw = doc.getTextWidth(ftxt) + 20;
    doc.setFillColor(...SOFTBLUE); doc.roundedRect(PW - M - fpw, y - 12, fpw, 18, 9, 9, "F");
    doc.setTextColor(...BLUE); doc.text(ftxt, PW - M - fpw / 2, y, { align: "center" });
  }
  y += 12;
  doc.setDrawColor(...LINE); doc.setLineWidth(0.6); doc.line(M, y, PW - M, y); y += 20;

  // ---- HERO: honorários em destaque ----
  const heroH = 66;
  doc.setFillColor(...SOFTBLUE); doc.roundedRect(M, y, CW, heroH, 10, 10, "F");
  doc.setFillColor(...BLUE); doc.roundedRect(M, y, 5, heroH, 2, 2, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(...BLUE);
  doc.text("HONORÁRIOS DO MÊS", M + 20, y + 22);
  doc.setFont("helvetica", "bold"); doc.setFontSize(26); doc.setTextColor(...INK);
  doc.text(BR(benef.honorarios), M + 20, y + 50);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...MUT);
  doc.text("base de cálculo da comissão", PW - M - 16, y + 44, { align: "right" });
  y += heroH + 14;

  // ---- Card único: Comissão (só isso; salário eles já têm no sistema) ----
  const ch = 60;
  doc.setFillColor(...SOFT); doc.roundedRect(M, y, CW, ch, 10, 10, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(...MUT);
  doc.text("COMISSÃO", M + 20, y + 24);
  doc.setFont("helvetica", "bold"); doc.setFontSize(22); doc.setTextColor(...INK);
  doc.text(benef.comissao == null ? "—" : BR(benef.comissao), M + 20, y + 48);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...MUT);
  doc.text(String(benef.faixa || ""), PW - M - 16, y + 44, { align: "right" });
  y += ch + 26;

  // ---- Faixas de honorário (chips horizontais) ----
  const faixas = faixasDoMes(previa);
  const ehGestao = String(benef.regra_comissao || "") === "percentual_total_honorario";
  const titulo = (t) => {
    doc.setFillColor(...BLUE); doc.roundedRect(M, y - 9, 3.5, 13, 1, 1, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...INK);
    doc.text(t, M + 11, y);
  };
  titulo("Faixas de comissão do mês");
  y += 14;

  if (ehGestao) {
    doc.setFillColor(...SOFTBLUE); doc.roundedRect(M, y, CW, 42, 9, 9, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...BLUE);
    doc.text(PCT(benef.percentual) + " sobre o honorário total da empresa", M + 16, y + 19);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUT);
    doc.text("Base do mês: " + BR(benef.honorarios), M + 16, y + 33);
    y += 42 + 14;
  } else if (!faixas.length) {
    doc.setFillColor(...SOFT); doc.roundedRect(M, y, CW, 30, 8, 8, "F");
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(...MUT);
    doc.text("Faixas de comissão não configuradas para este mês.", M + 14, y + 19);
    y += 30 + 14;
  } else {
    const atual = faixaAtualDoOperador(faixas, benef.honorarios);
    const n = faixas.length, cgap = 10, chipW = (CW - (n - 1) * cgap) / n, chipH = 62;
    faixas.forEach((fx, i) => {
      const x = M + i * (chipW + cgap);
      const ativa = fx.n === atual;
      if (ativa) { doc.setFillColor(...BLUE); } else { doc.setFillColor(...SOFT); }
      doc.roundedRect(x, y, chipW, chipH, 9, 9, "F");
      const cTxt = ativa ? [255, 255, 255] : INK, cMut = ativa ? [219, 231, 255] : MUT;
      doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(...cMut);
      doc.text("FAIXA " + fx.n, x + 12, y + 17);
      doc.setFont("helvetica", "bold"); doc.setFontSize(19); doc.setTextColor(...cTxt);
      doc.text(PCT(fx.pct), x + 12, y + 39);
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...cMut);
      doc.text("a partir de", x + 12, y + 51);
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(...cTxt);
      doc.text(BR(fx.valor), x + 12, y + 59);
    });
    y += chipH + 16;
    // faixa atual + progresso, numa faixa suave
    doc.setFillColor(...SOFTBLUE); doc.roundedRect(M, y, CW, 34, 8, 8, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(...INK);
    doc.text("Sua faixa: " + (atual ? "Faixa " + atual : "abaixo da mínima"), M + 16, y + 14);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...BLUE);
    if (benef.falta_proxima_faixa != null && Number(benef.falta_proxima_faixa) > 0) {
      doc.text("Faltam " + BR(benef.falta_proxima_faixa) + " em honorário para a próxima faixa.", M + 16, y + 27);
    } else {
      doc.setTextColor(...MUT);
      doc.text("Você está na faixa máxima atingível neste mês.", M + 16, y + 27);
    }
    y += 34 + 14;
  }

  // Rodape
  doc.setDrawColor(...LINE); doc.setLineWidth(0.6); doc.line(M, PH - 34, PW - M, PH - 34);
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

// Monta o doc (sem salvar) — util para testes headless.
export function construirDocOperador(benef, previa, mes, logo) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  desenharOperador(doc, benef, previa, mes, logo || null);
  return doc;
}

// Um PDF para UM operador.
export async function gerarPdfOperador(benef, previa, mes, logoCache) {
  const logo = logoCache !== undefined ? logoCache : await carregarLogo();
  const doc = construirDocOperador(benef, previa, mes, logo);
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

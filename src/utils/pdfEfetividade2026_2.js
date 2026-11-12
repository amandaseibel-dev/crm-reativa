// PDF da visão 2026/2 Consolidado. Função pura: recebe o que a tela já carregou
// e devolve o documento jsPDF. Não consulta nada, não lê estado de componente.
//
// Entrada = borderô de remessa. Os campos vêm de carteira_2026_2_contexto
// (primeira_remessa, ultima_remessa, remessas). Se um campo não vier na
// resposta, sai "não disponível" -- nunca uma data ou quantidade inventada.
// "Recuperado desde a entrada" não é medido nesta visão e o PDF declara isso.
import jsPDF from "jspdf";

const NAO_DISPONIVEL = "não disponível";

const dataBr = (v) => {
  if (!v) return NAO_DISPONIVEL;
  const d = new Date(String(v).length === 10 ? v + "T12:00:00" : v);
  return Number.isNaN(d.getTime()) ? NAO_DISPONIVEL : d.toLocaleDateString("pt-BR");
};

const quantidade = (v) => {
  if (v === null || v === undefined || v === "") return NAO_DISPONIVEL;
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("pt-BR") : NAO_DISPONIVEL;
};

export function montarPdfConsolidado2026_2({
  safra, indicadores = [], situacao = [], contexto = null, rodape = null,
  moeda = (v) => String(v), geradoEm = new Date(),
}) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const M = 40, CW = 595.28 - 2 * M, ALTURA_UTIL = 790;
  let y = 50;

  const linha = (texto, opts = {}) => {
    const tam = opts.tamanho || 10;
    doc.setFont("helvetica", opts.negrito ? "bold" : "normal");
    doc.setFontSize(tam);
    doc.splitTextToSize(String(texto), CW).forEach((p) => {
      if (y > ALTURA_UTIL) { doc.addPage(); y = 50; }
      doc.text(p, M, y);
      y += tam + 4;
    });
  };

  linha("Relatório 2026/2 — semestre vigente", { negrito: true, tamanho: 16 });
  linha("Carteira em curso: mostra o que já foi negociado e recebido. Não é inadimplência.", { tamanho: 9 });
  y += 6;
  linha("Filtros: safra " + safra + " · visão Consolidado · gerado em " + geradoEm.toLocaleString("pt-BR"), { tamanho: 9 });
  linha("Entrada: borderô de remessa. Primeira remessa " + dataBr(contexto?.primeira_remessa)
    + ", última " + dataBr(contexto?.ultima_remessa)
    + ", " + quantidade(contexto?.remessas) + " remessas.", { tamanho: 9 });
  y += 10;

  linha("Indicadores", { negrito: true, tamanho: 12 });
  indicadores.forEach((i) => linha(i.rotulo + ": " + i.valor + " — " + i.apoio));
  y += 8;

  linha("Situação do valor negociado", { negrito: true, tamanho: 12 });
  situacao.forEach((s) => linha(s.rotulo + ": " + moeda(s.valor)));
  y += 8;

  linha("Limitação", { negrito: true, tamanho: 12 });
  linha("Recuperado desde a entrada por borderô não é medido nesta visão. O valor recebido é o recebido dos acordos 2026/2, sem somar de novo o negociado.", { tamanho: 9 });
  if (rodape) { y += 8; linha(rodape, { tamanho: 9 }); }

  return doc;
}

export const NOME_ARQUIVO_PDF_2026_2 = "relatorio-2026-2-consolidado.pdf";

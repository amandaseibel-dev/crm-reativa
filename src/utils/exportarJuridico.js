// Excel do lote jurídico para o financeiro. Recebe o payload de
// `juridico_lote_enviar_financeiro` / `juridico_lote_exportar` -- que só traz
// caso APROVADO em diante. Leva CPF completo: a RPC é restrita à gestão e
// registra cada geração no histórico do lote.
import ExcelJS from "exceljs";
import { linhasDoLote } from "./juridico";

const AZUL = "FF1E40AF";
const MOEDA = '"R$" #,##0.00';

function aba(wb, nome, colunas, linhas, colunasMoeda = []) {
  const ws = wb.addWorksheet(nome);
  ws.columns = colunas;
  linhas.forEach((l) => ws.addRow(l));
  const cab = ws.getRow(1);
  cab.font = { bold: true, color: { argb: "FFFFFFFF" } };
  cab.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  cab.height = 24;
  for (let c = 1; c <= colunas.length; c++) {
    cab.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colunas.length } };
  colunasMoeda.forEach((k) => { ws.getColumn(k).numFmt = MOEDA; });
  return ws;
}

export async function montarPlanilhaJuridico(payload) {
  const { titulos, alunos } = linhasDoLote(payload);
  const wb = new ExcelJS.Workbook();
  wb.creator = "ReATIVA One";

  aba(wb, "Títulos", [
    { header: "Protocolo do lote", key: "protocolo", width: 20 },
    { header: "Aluno", key: "aluno", width: 38 },
    { header: "CPF", key: "cpf", width: 16 },
    { header: "Matrícula", key: "matricula", width: 14 },
    { header: "Situação acadêmica", key: "situacao_academica", width: 22 },
    { header: "Tipo", key: "tipo", width: 18 },
    { header: "Título / documento", key: "documento", width: 24 },
    { header: "Vencimento", key: "vencimento", width: 13 },
    { header: "Valor", key: "valor", width: 15 },
    { header: "Acordo nº", key: "acordo", width: 12 },
    { header: "Acordo ULBRA", key: "acordo_ulbra", width: 14 },
    { header: "Status do acordo", key: "acordo_status", width: 16 },
    { header: "Pendências / observações", key: "pendencias", width: 50 },
  ], titulos, ["valor"]);

  const total = alunos.reduce((s, a) => s + a.valor_total, 0);
  const wsA = aba(wb, "Alunos", [
    { header: "Protocolo do lote", key: "protocolo", width: 20 },
    { header: "Aluno", key: "aluno", width: 38 },
    { header: "CPF", key: "cpf", width: 16 },
    { header: "Matrícula", key: "matricula", width: 14 },
    { header: "Curso", key: "curso", width: 28 },
    { header: "Situação acadêmica", key: "situacao_academica", width: 22 },
    { header: "Qtd. títulos", key: "qtd_titulos", width: 12 },
    { header: "Mensalidades", key: "valor_mensalidades", width: 15 },
    { header: "Acordos", key: "valor_acordos", width: 15 },
    { header: "Total", key: "valor_total", width: 15 },
    { header: "Acordos nº", key: "acordos", width: 16 },
    { header: "Documentação", key: "documento", width: 34 },
    { header: "Link / localização do documento", key: "documento_ref", width: 40 },
    { header: "Pendências / observações", key: "pendencias", width: 50 },
  ], alunos, ["valor_mensalidades", "valor_acordos", "valor_total"]);
  const fim = wsA.addRow({ aluno: `TOTAL — ${alunos.length} aluno(s)`, valor_total: total });
  fim.font = { bold: true };

  aba(wb, "Lote", [
    { header: "Item", key: "k", width: 30 },
    { header: "Valor", key: "v", width: 70 },
  ], [
    { k: "Protocolo", v: payload?.protocolo || "" },
    { k: "Alunos solicitados pelo jurídico", v: payload?.qtd_solicitada ?? "" },
    { k: "Alunos neste arquivo", v: alunos.length },
    { k: "Títulos neste arquivo", v: titulos.length },
    { k: "Gerado em", v: new Date().toLocaleString("pt-BR") },
    { k: "Situação dos títulos", v: "Cobrança BLOQUEADA no CRM. Títulos não foram cancelados nem baixados." },
    { k: "Observação", v: "Encaminhamento para análise de ajuizamento. Não indica ajuizamento efetivo." },
  ]);
  return wb;
}

export async function exportarLoteJuridico(payload) {
  const wb = await montarPlanilhaJuridico(payload);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Juridico_${payload?.protocolo || "lote"}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

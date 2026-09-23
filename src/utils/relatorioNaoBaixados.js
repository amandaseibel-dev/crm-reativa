// Vocabulario e montagem do relatorio "Nao baixados / Rejeitados" da Projecao.
//
// SOMENTE LEITURA. Este arquivo nao chama RPC de escrita nenhuma: le
// `projecao_nao_baixados` (STABLE no banco) e transforma o resultado em tela e
// em planilha. FEITO e REJEITAR continuam sendo executados na fila de
// "Pagamentos sem vinculo", que e onde eles sempre estiveram.
//
// O estado e o motivo vem prontos do banco -- `pagamentos.status_conciliacao`
// e `fila_pagamento_sem_vinculo`. Aqui so se traduz codigo em portugues; se
// aparecer um codigo que esta tela nao conhece, ela mostra o codigo cru em vez
// de inventar rotulo, para ninguem ler um nome bonito por cima de um estado
// que ninguem mapeou.
import * as XLSX from "xlsx-js-style";
import { STATUS_CONCILIACAO, CONCLUSOES_FEITO, MOTIVOS_REJEICAO } from "./conciliacaoPagamento";
import { montarWorksheet, wbParaBlob, baixarBlob } from "./relatoriosProjecaoExcel";

// A pergunta "foi baixado?" tem TRES respostas, nao duas. "Nao baixou" e "nao
// ha registro de baixa" sao coisas diferentes: a segunda e a linha anterior a
// 14/09/2026, quando a conciliacao passou a gravar o desfecho. Juntar as duas
// transformaria ausencia de registro em prova de falha.
export const STATUS_BAIXA = {
  BAIXADO: "Baixado",
  NAO_BAIXADO: "Não baixado",
  NAO_REGISTRADO: "Sem registro de baixa",
};

export const SITUACAO_PARCELA = {
  PAGA: "Paga",
  VENCIDA: "Vencida",
  A_VENCER: "A vencer",
  CANCELADA: "Cancelada",
  SEM_PARCELA: "Boleto não existe em parcelas",
};

// O vocabulario e o da coluna `decisao` da fila. PENDENTE e a AUSENCIA de
// decisao -- e assim que as 19 funcoes que leem essa coluna definem pendente.
export const RESULTADO_ANALISE = {
  PENDENTE: "Pendente",
  FEITO: "Feito",
  REJEITADO: "Rejeitado",
  ENCERRADO_GESTAO: "Encerrado pela gestão",
  RESOLVIDO_AUTOMATICO: "Resolvido automaticamente",
  VINCULADO: "Vinculado a aluno",
  DESCARTADO: "Descartado",
  AGUARDANDO_TERCEIRO: "Aguardando terceiro",
  BAIXADO_SEM_PENDENCIA: "Baixado, sem pendência",
  SEM_ANALISE: "Sem análise registrada",
};

export const STATUS_FILA = {
  ABERTA: "Aberta na fila",
  DECIDIDA: "Decidida",
  FORA_DA_FILA: "Fora da fila",
};

// MOTIVO NUNCA VAZIO. Fora os estados da conciliacao, tres categorias proprias
// do relatorio. `MOTIVO_NAO_CLASSIFICADO` e o estado EXPLICITO para o que nao
// da para determinar -- e o que substitui o NULL que a gestao proibiu.
export const MOTIVO_CATEGORIA = {
  ...Object.fromEntries(Object.entries(STATUS_CONCILIACAO).map(([k, v]) => [k, v.rotulo])),
  SEM_PENDENCIA: "Sem pendência",
  BAIXA_DESFEITA_DEPOIS: "Baixa desfeita depois",
  MOTIVO_NAO_CLASSIFICADO: "Motivo não classificado",
};

const POR_VALOR = Object.fromEntries(CONCLUSOES_FEITO.map((c) => [c.valor, c.rotulo]));
const POR_MOTIVO = Object.fromEntries(MOTIVOS_REJEICAO.map((m) => [m.valor, m.rotulo]));

// Codigo desconhecido volta como ele mesmo: rotulo inventado esconderia um
// estado novo que ninguem mapeou ainda.
export function rotulo(mapa, codigo) {
  if (!codigo) return "";
  return mapa[codigo] || codigo;
}

export const rotuloConclusao = (c) => rotulo(POR_VALOR, c);
export const rotuloRejeicao = (m) => rotulo(POR_MOTIVO, m);

// --- formatacao -------------------------------------------------------------
export const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function dataBR(iso) {
  if (!iso) return "";
  const [a, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}

export function dataHoraBR(iso) {
  if (!iso) return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

// --- a linha do relatorio, ja em portugues ----------------------------------
// Um lugar so, usado pela tabela da tela E pela planilha: o que a gestao ve na
// tela e exatamente o que sai no arquivo.
export function linhaExportavel(l) {
  return {
    data_pagamento: dataBR(l.data_pagamento),
    importado_em: dataHoraBR(l.importado_em),
    arquivo_nome: l.arquivo_nome || "",
    aluno_nome: l.aluno_nome || "",
    matricula: l.matricula || "",
    cpf_mascarado: l.cpf_mascarado || "",
    boleto: l.boleto || "",
    documento: l.titulo_numero || "",
    acordo_numero: l.acordo_numero || "",
    parcela_numero: l.parcela_numero == null ? "" : String(l.parcela_numero),
    valor_pago: Number(l.valor_pago || 0),
    valor_honorario: Number(l.valor_honorario || 0),
    operador_nome: l.operador_nome || "",
    status_conciliacao: rotulo(MOTIVO_CATEGORIA, l.status_conciliacao) || "Sem estado registrado",
    status_baixa: rotulo(STATUS_BAIXA, l.status_baixa),
    situacao_parcela: rotulo(SITUACAO_PARCELA, l.situacao_parcela),
    motivo: rotulo(MOTIVO_CATEGORIA, l.motivo_categoria),
    motivo_detalhe: l.motivo_texto || "",
    status_fila: rotulo(STATUS_FILA, l.status_fila),
    resultado: rotulo(RESULTADO_ANALISE, l.resultado_analise),
    conclusao: rotuloConclusao(l.conclusao),
    motivo_rejeicao: rotuloRejeicao(l.motivo_rejeicao),
    observacao: l.observacao || "",
    decidido_por: l.decidido_por || "",
    decidido_em: dataHoraBR(l.decidido_em),
    saldo_total: Number(l.saldo_total || 0),
    saldo_vencido: Number(l.saldo_vencido || 0),
    primeira_tentativa: dataHoraBR(l.primeira_tentativa_em),
    ultima_tentativa: dataHoraBR(l.ultima_tentativa_em),
    quantidade_tentativas: Number(l.quantidade_tentativas || 0),
  };
}

export const COLUNAS_PAGAMENTO = [
  { h: "Data do pagamento", k: "data_pagamento", t: "text", w: 15 },
  { h: "Importado na Projeção", k: "importado_em", t: "text", w: 18 },
  { h: "Arquivo de origem", k: "arquivo_nome", t: "text", w: 20 },
  { h: "Aluno", k: "aluno_nome", t: "text", w: 34 },
  { h: "Matrícula", k: "matricula", t: "text", w: 13 },
  { h: "CPF", k: "cpf_mascarado", t: "text", w: 16 },
  { h: "Boleto", k: "boleto", t: "text", w: 15 },
  { h: "Documento/título", k: "documento", t: "text", w: 14 },
  { h: "Acordo identificado", k: "acordo_numero", t: "text", w: 14 },
  { h: "Parcela", k: "parcela_numero", t: "text", w: 9 },
  { h: "Valor recebido", k: "valor_pago", t: "moeda", w: 15 },
  { h: "Honorário", k: "valor_honorario", t: "moeda", w: 13 },
  { h: "Operador", k: "operador_nome", t: "text", w: 16 },
  { h: "Status da conciliação", k: "status_conciliacao", t: "text", w: 22 },
  { h: "Status da baixa", k: "status_baixa", t: "text", w: 20 },
  { h: "Situação atual da parcela", k: "situacao_parcela", t: "text", w: 26 },
  { h: "Motivo de não ter baixado", k: "motivo", t: "text", w: 26 },
  { h: "Motivo — detalhe", k: "motivo_detalhe", t: "text", w: 70 },
  { h: "Status da fila", k: "status_fila", t: "text", w: 15 },
  { h: "Resultado da análise", k: "resultado", t: "text", w: 22 },
  { h: "Conclusão do FEITO", k: "conclusao", t: "text", w: 28 },
  { h: "Motivo da REJEIÇÃO", k: "motivo_rejeicao", t: "text", w: 28 },
  { h: "Observação", k: "observacao", t: "text", w: 60 },
  { h: "Responsável pela decisão", k: "decidido_por", t: "text", w: 26 },
  { h: "Data/hora da decisão", k: "decidido_em", t: "text", w: 18 },
  { h: "Saldo atual do aluno", k: "saldo_total", t: "moeda", w: 17 },
  { h: "Saldo vencido", k: "saldo_vencido", t: "moeda", w: 15 },
  { h: "Primeira tentativa", k: "primeira_tentativa", t: "text", w: 18 },
  { h: "Última tentativa", k: "ultima_tentativa", t: "text", w: 18 },
  { h: "Tentativas", k: "quantidade_tentativas", t: "int", w: 11 },
];

export const COLUNAS_ALUNO = [
  { h: "Aluno", k: "aluno_nome", t: "text", w: 34 },
  { h: "Matrícula", k: "matricula", t: "text", w: 13 },
  { h: "CPF", k: "cpf_mascarado", t: "text", w: 16 },
  { h: "Pagamentos não baixados", k: "qtd_nao_baixado", t: "int", w: 22 },
  { h: "Pagamentos no relatório", k: "qtd", t: "int", w: 20 },
  { h: "Valor total", k: "valor_total", t: "moeda", w: 16 },
  { h: "Pendentes", k: "qtd_pendente", t: "int", w: 11 },
  { h: "Feito", k: "qtd_feito", t: "int", w: 9 },
  { h: "Rejeitado", k: "qtd_rejeitado", t: "int", w: 11 },
  { h: "Saldo atual", k: "saldo_total", t: "moeda", w: 16 },
  { h: "Pagamento mais antigo", k: "pagamento_mais_antigo", t: "text", w: 20 },
  { h: "Último pagamento", k: "ultimo_pagamento", t: "text", w: 18 },
  { h: "Principal motivo", k: "principal_motivo", t: "text", w: 26 },
];

export function linhaAlunoExportavel(a) {
  return {
    aluno_nome: a.aluno_nome || "",
    matricula: a.matricula || "",
    cpf_mascarado: a.cpf_mascarado || "",
    qtd: Number(a.qtd || 0),
    qtd_nao_baixado: Number(a.qtd_nao_baixado || 0),
    valor_total: Number(a.valor_total || 0),
    qtd_pendente: Number(a.qtd_pendente || 0),
    qtd_feito: Number(a.qtd_feito || 0),
    qtd_rejeitado: Number(a.qtd_rejeitado || 0),
    saldo_total: Number(a.saldo_total || 0),
    pagamento_mais_antigo: dataBR(a.pagamento_mais_antigo),
    ultimo_pagamento: dataBR(a.ultimo_pagamento),
    principal_motivo: rotulo(MOTIVO_CATEGORIA, a.principal_motivo),
  };
}

// A ABA "COMO LER" NAO E ENFEITE. O arquivo sai da tela e circula sozinho; sem
// ela, "MOTIVO_NAO_CLASSIFICADO" vira suspeita de bug em vez do que e -- linha
// importada antes de a conciliacao existir.
export function abaComoLer(filtros, contadores, gerado_em) {
  const linhas = [
    ["Relatório", "Não baixados / Rejeitados — Projeção Diária"],
    ["Gerado em", dataHoraBR(gerado_em) || dataHoraBR(new Date().toISOString())],
    ["Universo", "somente pagamentos importados pela Projeção (importações do tipo PROJECAO_DIARIA)"],
    ["", ""],
    ["Pagamentos no relatório", Number(contadores?.linhas || 0)],
    ["Valor total", moeda(contadores?.valor_total)],
    ["Não baixados", Number(contadores?.nao_baixados || 0)],
    ["Valor não baixado", moeda(contadores?.valor_nao_baixado)],
    ["Pendentes", Number(contadores?.pendentes || 0)],
    ["Feito", Number(contadores?.feito || 0)],
    ["Rejeitados", Number(contadores?.rejeitado || 0)],
    ["Encerrados pela gestão", Number(contadores?.encerrado_gestao || 0)],
    ["Resolvidos automaticamente", Number(contadores?.resolvido_automatico || 0)],
    ["Sem estrutura de acordo", Number(contadores?.sem_estrutura || 0)],
    ["Aguardando acordo", Number(contadores?.aguardando_acordo || 0)],
    ["Alunos únicos", Number(contadores?.alunos_unicos || 0)],
    ["Linhas sem motivo", Number(contadores?.sem_motivo || 0)],
    ["", ""],
    ["Filtros aplicados", JSON.stringify(filtros || {})],
    ["", ""],
    ["Motivo não classificado", "linha importada antes de 14/09/2026, quando a conciliação passou a registrar o desfecho de cada pagamento. Não é falha do relatório: é ausência de registro na origem."],
    ["Sem registro de baixa", "o mesmo caso: não há como provar, hoje, qual pagamento baixou aquela parcela."],
    ["Resolvido automaticamente", "a pendência acabou sozinha — o motor baixou depois, ou a conferência automática encerrou."],
    ["Este relatório", "é somente leitura. Abrir a tela ou exportar não baixa, não devolve baixa, não reprocessa e não altera a fila. FEITO e REJEITAR continuam em Pagamentos sem vínculo."],
  ];
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  ws["!cols"] = [{ wch: 30 }, { wch: 110 }];
  return ws;
}

export function montarWorkbook({ linhas, por_aluno, contadores, filtros, gerado_em }) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, abaComoLer(filtros, contadores, gerado_em), "Como ler");
  XLSX.utils.book_append_sheet(
    wb,
    montarWorksheet(COLUNAS_PAGAMENTO, (linhas || []).map(linhaExportavel)),
    "Por pagamento",
  );
  XLSX.utils.book_append_sheet(
    wb,
    montarWorksheet(COLUNAS_ALUNO, (por_aluno || []).map(linhaAlunoExportavel)),
    "Por aluno",
  );
  return wb;
}

export function nomeArquivo(agora = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `nao-baixados-projecao-${agora.getFullYear()}${p(agora.getMonth() + 1)}${p(agora.getDate())}-${p(agora.getHours())}${p(agora.getMinutes())}.xlsx`;
}

export function exportar(resultado) {
  baixarBlob(nomeArquivo(), wbParaBlob(montarWorkbook(resultado || {})));
}

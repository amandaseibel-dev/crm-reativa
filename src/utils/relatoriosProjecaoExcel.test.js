import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx-js-style";
import JSZip from "jszip";
import {
  montarWorksheet, abaPremiacaoSintetica, montarWorkbookIndividual,
  montarWorkbookGeral, montarZipIndividuais, nomeArquivoIndividual,
} from "./relatoriosProjecaoExcel";
import { EQUIPE_9_EMAILS } from "./operadores";

const payloadDe = (nome, hon, faixa, pct, premia) => ({
  operador_nome: nome, acumulado_mes: hon * 13, honorario_mes: hon,
  meta_honorario_individual: 60000.01, percentual_meta_individual_realizado: 10,
  projecao_honorario_individual: hon * 2, percentual_projecao_individual: 20,
  faixa_atual: faixa, comissao_estimada_individual: premia,
  proxima_faixa_valor: 45000.01, falta_proxima_faixa: 45000.01 - hon,
  recuperado_hoje: 100, honorario_hoje: 10, qtd_pagamentos_hoje: 3,
  config_metas: { m1_percentual: 4, m2_valor: 38000.01, m2_percentual: 8, m3_valor: 45000.01, m3_percentual: 9, m4_valor: 60000.01, m4_percentual: 9.5 },
  historico_dia_a_dia: [
    { dia: "2026-07-01", recuperado_dia: 500, honorario_dia: hon / 2, qtd_pagamentos_dia: 2, recuperado_acumulado: 500, honorario_acumulado: hon / 2, percentual_meta: 5, faixa, percentual_comissao: pct, comissao_estimada: premia / 2, falta_proxima_faixa: 100 },
    { dia: "2026-07-02", recuperado_dia: 500, honorario_dia: hon / 2, qtd_pagamentos_dia: 1, recuperado_acumulado: 1000, honorario_acumulado: hon, percentual_meta: 8, faixa, percentual_comissao: pct, comissao_estimada: premia, falta_proxima_faixa: 50 },
  ],
});

const pagamentosDe = () => ({
  itens: [
    { pagamento_id: "a", data_pagamento: "2026-07-01", aluno_nome: "Aluno X", valor_pago: 600, valor_honorario: 300, importacao_id: null, operador_ajustado_manualmente: false },
    { pagamento_id: "b", data_pagamento: "2026-07-02", aluno_nome: "Aluno Y", valor_pago: 400, valor_honorario: 200, importacao_id: "11111111-1111-1111-1111-111111111111", operador_ajustado_manualmente: true },
  ],
  soma_pago: 1000, soma_honorario: 500,
});

describe("montarWorksheet", () => {
  it("gera cabeçalho, linhas, totais, autofilter e freeze", () => {
    const ws = montarWorksheet(
      [{ h: "Nome", k: "n", t: "text", w: 20 }, { h: "Valor", k: "v", t: "moeda", w: 16 }],
      [{ n: "A", v: 10 }, { n: "B", v: 20 }],
      { n: "TOTAL", v: 30 }
    );
    expect(ws["A1"].v).toBe("Nome");
    expect(ws["A1"].s.font.bold).toBe(true);        // header em negrito
    expect(ws["B2"].z).toContain("R$");             // formato moeda
    expect(ws["!autofilter"]).toBeTruthy();
    expect(ws["!freeze"]).toBeTruthy();             // cabeçalho congelado
    expect(ws["A4"].v).toBe("TOTAL");               // linha de totais
    expect(ws["A4"].s.font.bold).toBe(true);
  });
});

describe("abaPremiacaoSintetica", () => {
  it("soma exatamente os 9 e destaca o total", () => {
    const map = {};
    EQUIPE_9_EMAILS.forEach((e, i) => { map[e] = payloadDe(`OP${i}`, 1000, "Faixa 1 (4%)", 4, 40); });
    const ws = abaPremiacaoSintetica(map, "2026-07");
    // 1 header + 9 linhas + 1 total = 11 linhas
    const range = XLSX.utils.decode_range(ws["!ref"]);
    expect(range.e.r).toBe(10);
    // total honorário = 9 * 1000
    expect(ws["D11"].v).toBe(9000);
    // total premiação = 9 * 40
    expect(ws["G11"].v).toBe(360);
  });
});

describe("montarWorkbookIndividual", () => {
  it("tem exatamente as 4 abas e confere os totais de pagamentos", () => {
    const wb = montarWorkbookIndividual(payloadDe("DIEGO", 1000, "Faixa 1 (4%)", 4, 40), "2026-07", pagamentosDe());
    expect(wb.SheetNames).toEqual(["Resumo da Premiação", "Pagamentos do Operador", "Evolução Diária", "Regras e Conferência"]);
    // round-trip: escreve e relê
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const lido = XLSX.read(buf, { type: "array" });
    expect(lido.SheetNames.length).toBe(4);
    const wsPag = lido.Sheets["Pagamentos do Operador"];
    const linhas = XLSX.utils.sheet_to_json(wsPag, { header: 1 });
    const totalRow = linhas[linhas.length - 1];
    expect(totalRow[0]).toBe("TOTAL");
    expect(totalRow[3]).toBe(1000); // soma recuperado
    expect(totalRow[4]).toBe(500);  // soma honorário
  });
});

describe("montarWorkbookGeral", () => {
  it("tem Resumo Geral + Premiação (9) + Relatório Geral Pagamentos", () => {
    const geral = {
      totais: [
        { classificacao: "EQUIPE_9", qtd: 10, total_pago: 9000, total_honorario: 900, participa_premiacao: true },
        { classificacao: "FERNANDA", qtd: 2, total_pago: 1000, total_honorario: 70, participa_premiacao: false },
      ],
      itens: [{ pagamento_id: "a", data_pagamento: "2026-07-01", operador_email: "cobranca13@aelbra.com.br", classificacao_pagamento: "EQUIPE_9", participa_premiacao: true, aluno_nome: "X", valor_pago: 100, valor_honorario: 10 }],
    };
    const map = {}; EQUIPE_9_EMAILS.forEach((e, i) => { map[e] = payloadDe(`OP${i}`, 1000, "Faixa 1 (4%)", 4, 40); });
    const wb = montarWorkbookGeral({ honorario_mes: 970 }, geral, "2026-07", map);
    expect(wb.SheetNames).toContain("Resumo Geral");
    expect(wb.SheetNames).toContain("Premiação RH (9)");
    expect(wb.SheetNames).toContain("Relatório Geral Pagamentos");
  });
});

describe("montarZipIndividuais", () => {
  it("gera exatamente 9 arquivos .xlsx", async () => {
    const map = {}; const pags = {};
    EQUIPE_9_EMAILS.forEach((e, i) => { map[e] = payloadDe(`OP${i}`, 1000, "Faixa 1 (4%)", 4, 40); pags[e] = pagamentosDe(); });
    const zip = montarZipIndividuais("2026-07", map, pags);
    const buf = await zip.generateAsync({ type: "uint8array" });
    const relido = await JSZip.loadAsync(buf);
    const arquivos = Object.keys(relido.files).filter((f) => f.endsWith(".xlsx"));
    expect(arquivos.length).toBe(9);
    expect(arquivos).toContain(nomeArquivoIndividual("cobranca13@aelbra.com.br", "2026-07"));
  });
});

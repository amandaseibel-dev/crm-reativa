// Excel do Jurídico: o que vai para o financeiro tem de bater com o que foi
// aprovado -- uma linha por título, sem valor contado duas vezes.
import { describe, it, expect } from "vitest";
import { cpfFormatado, dataBr, linhasDoLote, pendenciaImpeditiva, rotuloDivergencia, rotuloPendencia, rotuloTermo } from "./juridico";
import { montarPlanilhaJuridico } from "./exportarJuridico";

const PAYLOAD = {
  protocolo: "JUR-20261112-0001",
  qtd_solicitada: 2,
  casos: [
    {
      caso_id: "c1", aluno: "Aluna Teste Alfa", cpf: "12345678901", matricula: "9001",
      curso: "Direito", situacao_academica: "Formado", documento: "Conferido no CRM / não se aplica",
      titulos: [
        { tipo: "MENSALIDADE", documento: "DOC-1", vencimento: "2025-06-10", valor: 1000 },
        { tipo: "MENSALIDADE", documento: "DOC-2", vencimento: "2025-07-10", valor: 500.5 },
      ],
    },
    {
      caso_id: "c2", aluno: "Aluno Teste Beta", cpf: "98765432100", matricula: "9002",
      curso: "Enfermagem", situacao_academica: "Trancado",
      acordo_ativo_motivo: "pedido expresso do jurídico",
      documento: "Pendência autorizada pelo jurídico", documento_autorizacao: "Dra. Fulana, 12/11",
      titulos: [
        { tipo: "MENSALIDADE", documento: "DOC-3", vencimento: "2025-03-10", valor: 700 },
        { tipo: "PARCELA_ACORDO", documento: "Acordo 5001 parc. 1", vencimento: "2025-08-10", valor: 300, acordo_numero: 5001, acordo_status: "ATIVO" },
        { tipo: "PARCELA_ACORDO", documento: "Acordo 5001 parc. 2", vencimento: "2026-01-10", valor: 300, acordo_numero: 5001, acordo_status: "ATIVO" },
      ],
    },
  ],
};

describe("linhas do lote", () => {
  it("uma linha por título, com protocolo, CPF, matrícula e situação acadêmica em todas", () => {
    const { titulos } = linhasDoLote(PAYLOAD);
    expect(titulos).toHaveLength(5);
    for (const t of titulos) {
      expect(t.protocolo).toBe("JUR-20261112-0001");
      expect(t.cpf).toMatch(/^\d{3}\.\d{3}\.\d{3}-\d{2}$/);
      expect(t.matricula).toBeTruthy();
      expect(t.situacao_academica).toBeTruthy();
    }
    expect(titulos[3]).toMatchObject({ tipo: "Parcela de acordo", acordo: "5001", vencimento: "10/08/2025", valor: 300 });
  });

  it("o resumo por aluno soma exatamente os títulos — nada duplicado, nada perdido", () => {
    const { titulos, alunos } = linhasDoLote(PAYLOAD);
    expect(alunos.map((a) => a.valor_total)).toEqual([1500.5, 1300]);
    expect(alunos[1]).toMatchObject({ valor_mensalidades: 700, valor_acordos: 600, acordos: "5001", qtd_titulos: 3 });
    const somaTitulos = titulos.reduce((s, t) => s + t.valor, 0);
    const somaAlunos = alunos.reduce((s, a) => s + a.valor_total, 0);
    expect(somaAlunos).toBe(somaTitulos);
  });

  it("pendências liberadas aparecem no arquivo: acordo ativo aprovado e termo autorizado", () => {
    const { alunos, titulos } = linhasDoLote(PAYLOAD);
    expect(alunos[0].pendencias).toBe("");
    expect(alunos[1].pendencias).toContain("Acordo ativo aprovado: pedido expresso do jurídico");
    expect(alunos[1].pendencias).toContain("Termo pendente, autorizado: Dra. Fulana, 12/11");
    expect(titulos[2].pendencias).toBe(alunos[1].pendencias);
  });

  it("lote vazio não quebra", () => {
    expect(linhasDoLote({ protocolo: "x", casos: [] })).toEqual({ titulos: [], alunos: [] });
    expect(linhasDoLote(null)).toEqual({ titulos: [], alunos: [] });
  });
});

describe("planilha", () => {
  it("tem as abas Títulos, Alunos e Lote, com o total batendo e o aviso de que não é ajuizamento", async () => {
    const wb = await montarPlanilhaJuridico(PAYLOAD);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Títulos", "Alunos", "Lote"]);
    const t = wb.getWorksheet("Títulos");
    expect(t.rowCount).toBe(6); // cabeçalho + 5 títulos
    expect(t.getRow(1).values.slice(1, 6)).toEqual(["Protocolo do lote", "Aluno", "CPF", "Matrícula", "Situação acadêmica"]);
    const a = wb.getWorksheet("Alunos");
    expect(a.getRow(a.rowCount).getCell("valor_total").value).toBe(2800.5);
    const lote = wb.getWorksheet("Lote").getSheetValues().flat().join(" ");
    expect(lote).toContain("JUR-20261112-0001");
    expect(lote).toContain("Não indica ajuizamento efetivo");
    expect(lote).toContain("Títulos não foram cancelados");
  });
});

describe("rótulos", () => {
  it("pendência impeditiva é a que começa por '!'", () => {
    expect(pendenciaImpeditiva("!PAGAMENTO_PENDENTE")).toBe(true);
    expect(pendenciaImpeditiva("TERMO_NAO_LOCALIZADO")).toBe(false);
    expect(rotuloPendencia("!PAGAMENTO_PENDENTE")).toBe("Pagamento aguardando confirmação");
    expect(rotuloPendencia("!BLOQUEIO_ADMINISTRATIVO:SUSPENSAO_COBRANCA")).toContain("suspensao cobranca");
    expect(rotuloPendencia("CODIGO_NOVO")).toBe("CODIGO_NOVO");
    expect(rotuloPendencia("!PAGAMENTO_NAO_BAIXADO")).toBe("Pagamento recebido e ainda não baixado");
    expect(rotuloDivergencia("PAGAMENTO_NAO_BAIXADO")).toBe("Pagamento recebido e não baixado");
  });

  it("termo não localizado nunca é mostrado como resolvido sem vínculo ou autorização", () => {
    const naoLocalizado = { termo: { status: "NAO_LOCALIZADO" } };
    expect(rotuloTermo(naoLocalizado, {})).toBe("Termo NÃO localizado");
    expect(rotuloTermo({ termo: { status: "VALIDAR" } }, {})).toBe("Termo precisa de validação");
    expect(rotuloTermo(naoLocalizado, { doc_manual: { referencia: "x" } })).toBe("Documento vinculado manualmente");
    expect(rotuloTermo(naoLocalizado, { doc_autorizado_em: "2026-11-12" })).toBe("Pendência autorizada pelo jurídico");
  });

  it("datas e CPF não passam por fuso nem perdem dígito", () => {
    expect(dataBr("2025-01-01")).toBe("01/01/2025");
    expect(dataBr("2026-11-12T02:30:00+00:00")).toBe("12/11/2026");
    expect(dataBr(null)).toBe("");
    expect(cpfFormatado("12345678901")).toBe("123.456.789-01");
    expect(cpfFormatado("123")).toBe("123");
  });
});

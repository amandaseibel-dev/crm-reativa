import { describe, it, expect } from "vitest";
import {
  validarCarrier,
  validarStudentSearchItem,
  validarFinancialStatementItem,
  validarStudentComposite,
  validarEnvelopePaginado,
  validarAgreementsResponse,
} from "./primeApiContrato";

// Teste de CONTRATO, não de negócio: confere que a FORMA das respostas da API
// Prime/ULBRA continua batendo com o que docs/integracoes/prime-api.md
// documenta. As fixtures abaixo são sanitizadas (sem CPF/nome real) e
// reproduzem exatamente os exemplos do manual.
//
// Se este teste começar a falhar depois de uma sondagem real (via Edge
// Function `prime-sonda`), o próximo passo é atualizar a fixture aqui E os
// três documentos em docs/integracoes/ no mesmo commit — nunca só o teste.

describe("contrato Prime/ULBRA — carriers", () => {
  it("aceita um carrier no formato documentado", () => {
    const fixture = { id: 166, name: "SANTANDER REATIVA", covenant: "0272047", isCollectionAgency: false };
    expect(validarCarrier(fixture)).toEqual([]);
  });

  it("aceita covenant nulo (observado no portador 195)", () => {
    const fixture = { id: 195, name: "REATIVA RECUPERACAO DE CREDITO", covenant: null, isCollectionAgency: true };
    expect(validarCarrier(fixture)).toEqual([]);
  });

  it("acusa quando id deixa de ser numérico", () => {
    const fixture = { id: "166", name: "SANTANDER REATIVA" };
    expect(validarCarrier(fixture).length).toBeGreaterThan(0);
  });

  it("acusa ausência do campo id", () => {
    expect(validarCarrier({ name: "SEM ID" }).length).toBeGreaterThan(0);
  });
});

describe("contrato Prime/ULBRA — students_search", () => {
  it("aceita um item no formato documentado", () => {
    const fixture = { registration: "2025001213", name: "Fulana de Tal", cpf: "02881891160" };
    expect(validarStudentSearchItem(fixture)).toEqual([]);
  });

  it("acusa ausência de cpf", () => {
    const fixture = { registration: "2025001213", name: "Fulana de Tal" };
    expect(validarStudentSearchItem(fixture)).toEqual(["students_search.item.cpf: campo obrigatório ausente"]);
  });
});

describe("contrato Prime/ULBRA — financial_statement", () => {
  it("aceita uma linha completa no formato documentado", () => {
    const fixture = {
      boleto: "4039712", documentNumber: "0104270450100",
      carrier: { id: 195, name: "REATIVA RECUPERACAO DE CREDITO" },
      dueDate: "2026-01-05", paymentDate: "2026-09-14",
      grossAmount: 550.0, discountAmount: 0, penaltyAmount: 0,
      interestAmount: null, honorariumAmount: 45.0, netAmount: 595.0,
      paidAmount: 1110.12, isAgreementInstallment: false,
    };
    expect(validarFinancialStatementItem(fixture)).toEqual([]);
  });

  it("aceita interestAmount nulo (observado em 100% das linhas de acordo)", () => {
    const fixture = { boleto: "123", carrier: { id: 166 }, interestAmount: null };
    expect(validarFinancialStatementItem(fixture)).toEqual([]);
  });

  it("acusa ausência de boleto — a ponte para acordos_titulos.documento depende dele", () => {
    const fixture = { carrier: { id: 195 } };
    expect(validarFinancialStatementItem(fixture)).toEqual(["financial_statement.item.boleto: campo obrigatório ausente"]);
  });

  it("acusa carrier vindo como string em vez de objeto", () => {
    const fixture = { boleto: "123", carrier: "195" };
    expect(validarFinancialStatementItem(fixture).length).toBeGreaterThan(0);
  });
});

describe("contrato Prime/ULBRA — student_composite", () => {
  it("aceita o objeto composto com os quatro blocos documentados", () => {
    const fixture = { registrationData: { cpf: "02881891160" }, contracts: [], financialStatement: [], agreements: [] };
    expect(validarStudentComposite(fixture)).toEqual([]);
  });

  it("acusa quando um dos quatro blocos some da resposta", () => {
    const fixture = { registrationData: {}, contracts: [], financialStatement: [] };
    expect(validarStudentComposite(fixture)).toEqual(["student_composite.agreements: campo obrigatório ausente"]);
  });
});

describe("contrato Prime/ULBRA — agreements (o gap central)", () => {
  it("aceita o envelope vazio — é a resposta observada em 100% dos testes realizados", () => {
    const fixture = { items: [], totalItems: 0 };
    expect(validarAgreementsResponse(fixture)).toEqual([]);
  });

  it("acusa se o envelope de paginação mudar de forma", () => {
    const fixture = { items: [], total: 0 };
    expect(validarEnvelopePaginado(fixture).length).toBeGreaterThan(0);
  });

  it("sinaliza claramente se agreements deixar de vir vazio — é o gap prioritário do mapeamento", () => {
    const fixture = { items: [{ id: 71903 }], totalItems: 1 };
    const erros = validarAgreementsResponse(fixture);
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/agreements deixou de vir vazio/);
  });
});

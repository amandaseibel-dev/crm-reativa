// Resumo do payload cru de `/students/{reg}/agreements`, como a `prime-sonda`
// o devolve com `cru: true`.
//
// O caso central é a TRÍADE que o diagnóstico não pode confundir:
//   1. a API não trouxe lista de parcelas      -> tem_lista_parcelas = false
//   2. trouxe a lista, sem campo de situação   -> situacao_conhecida = false
//   3. trouxe a lista com situação             -> contagens válidas
// Tratar (1) e (2) como a mesma coisa faria a tela dizer "não há parcela não
// paga" quando o certo é "não sei" — e essa confusão decidiria errado o futuro
// da sincronização.
//
// O segundo caso central é privacidade: o payload da API traz valor, data e
// boleto. Nada disso pode atravessar o resumidor.
import { describe, it, expect } from "vitest";
import { resumirAgreementsCru } from "./diagnosticoAcordos.js";

// Payload COM dado sensível de propósito, para o teste de privacidade ter o que pegar.
const ACORDO_COMPLETO = [
  {
    id: 71903,
    status: "Confirmado",
    totalValue: 3975.57,
    signatureDate: "2026-09-16",
    newInstallments: [
      { documentNumber: "50719030001", dueDate: "2026-09-16", value: 429.36, paymentDate: "2026-09-16", paidAmount: 429.36 },
      { documentNumber: "50719030002", dueDate: "2026-10-16", value: 429.36, paymentDate: null, paidAmount: 0 },
      { documentNumber: "50719030003", dueDate: "2026-11-16", value: 429.36, paymentDate: null, paidAmount: 0 },
    ],
  },
];

describe("resumirAgreementsCru — a resposta vazia que a API dá hoje", () => {
  it("lista vazia: zero acordos, sem campo, sem lista de parcelas", () => {
    const r = resumirAgreementsCru({ items: [], totalItems: 0 });
    expect(r.forma_reconhecida).toBe(true);
    expect(r.acordos).toBe(0);
    expect(r.campos).toEqual([]);
    expect(r.tem_lista_parcelas).toBe(false);
    expect(r.situacao_conhecida).toBe(false);
  });

  it("array vazio direto também é forma reconhecida", () => {
    const r = resumirAgreementsCru([]);
    expect(r.forma_reconhecida).toBe(true);
    expect(r.acordos).toBe(0);
  });

  it("forma inesperada é dita como tal, com os campos do topo para diagnóstico", () => {
    const r = resumirAgreementsCru({ erro: "x", detalhe: "y" });
    expect(r.forma_reconhecida).toBe(false);
    expect(r.campos_no_topo).toEqual(["detalhe", "erro"]);
    expect(r.acordos).toBe(0);
  });

  it("aguenta nulo, texto e lixo sem quebrar", () => {
    for (const entrada of [null, undefined, "x", 0, [null], [{}], [[]]]) {
      expect(() => resumirAgreementsCru(entrada)).not.toThrow();
    }
  });
});

describe("resumirAgreementsCru — a resposta completa que queremos descobrir", () => {
  it("conta acordos, lista nomes de campo e enxerga a lista de parcelas", () => {
    const r = resumirAgreementsCru(ACORDO_COMPLETO);
    expect(r.acordos).toBe(1);
    expect(r.campos).toEqual(["id", "newInstallments", "signatureDate", "status", "totalValue"]);
    expect(r.tem_lista_parcelas).toBe(true);
    expect(r.parcelas).toBe(3);
    expect(r.campos_parcela).toEqual(["documentNumber", "dueDate", "paidAmount", "paymentDate", "value"]);
  });

  it("separa paga de NÃO PAGA — é a pergunta da gestão", () => {
    const r = resumirAgreementsCru(ACORDO_COMPLETO);
    expect(r.situacao_conhecida).toBe(true);
    expect(r.parcelas_pagas).toBe(1);
    expect(r.parcelas_nao_pagas).toBe(2);
  });

  it("reconhece a lista sob outros nomes possíveis", () => {
    for (const nome of ["installments", "parcels", "parcelas"]) {
      const r = resumirAgreementsCru([{ id: 1, [nome]: [{ status: "Aberta" }] }]);
      expect(r.tem_lista_parcelas).toBe(true);
      expect(r.parcelas).toBe(1);
    }
  });

  it("status textual também classifica", () => {
    const r = resumirAgreementsCru([
      { id: 1, installments: [{ status: "Quitada" }, { status: "Aberta" }, { situation: "PAGO" }] },
    ]);
    expect(r.parcelas_pagas).toBe(2);
    expect(r.parcelas_nao_pagas).toBe(1);
  });

  it("soma vários acordos do mesmo aluno", () => {
    const r = resumirAgreementsCru([
      { id: 1, installments: [{ paymentDate: "2026-01-01" }] },
      { id: 2, installments: [{ paymentDate: null }, { paymentDate: null }] },
    ]);
    expect(r.acordos).toBe(2);
    expect(r.parcelas).toBe(3);
    expect(r.parcelas_pagas).toBe(1);
    expect(r.parcelas_nao_pagas).toBe(2);
  });
});

describe("A TRÍADE: ausência de lista ≠ situação desconhecida ≠ zero não pagas", () => {
  it("1. sem lista de parcelas: tem_lista_parcelas false, situacao_conhecida false", () => {
    const r = resumirAgreementsCru([{ id: 1, status: "Confirmado", totalValue: 100 }]);
    expect(r.acordos).toBe(1);
    expect(r.tem_lista_parcelas).toBe(false);
    expect(r.situacao_conhecida).toBe(false);
    expect(r.parcelas).toBe(0);
  });

  it("2. COM lista, SEM campo de situação: lista true, situação false, contagens zeradas", () => {
    const r = resumirAgreementsCru([
      { id: 1, newInstallments: [{ documentNumber: "a" }, { documentNumber: "b" }] },
    ]);
    expect(r.tem_lista_parcelas).toBe(true);
    expect(r.parcelas).toBe(2);
    expect(r.situacao_conhecida).toBe(false);
    expect(r.parcelas_pagas).toBe(0);
    expect(r.parcelas_nao_pagas).toBe(0);
  });

  it("3. parcela sem sinal não entra em nenhuma contagem, mesmo convivendo com outras que têm", () => {
    const r = resumirAgreementsCru([
      { id: 1, newInstallments: [{ paymentDate: null }, { documentNumber: "sem sinal" }] },
    ]);
    expect(r.parcelas).toBe(2);
    expect(r.situacao_conhecida).toBe(true);
    expect(r.parcelas_pagas + r.parcelas_nao_pagas).toBe(1);
  });
});

describe("PRIVACIDADE — nenhum valor atravessa o resumidor", () => {
  it("nenhum boleto, data, valor ou identificador aparece no resultado", () => {
    const texto = JSON.stringify(resumirAgreementsCru(ACORDO_COMPLETO));
    expect(texto).not.toMatch(/50719030001/);  // boleto
    expect(texto).not.toMatch(/3975\.57/);     // valor negociado
    expect(texto).not.toMatch(/429\.36/);      // valor da parcela
    expect(texto).not.toMatch(/2026-09-16/);   // data
    expect(texto).not.toMatch(/71903/);        // número do acordo
    expect(texto).not.toMatch(/Confirmado/);   // valor do campo status
  });

  it("de `campos` e `campos_parcela` sai só NOME, nunca valor", () => {
    const r = resumirAgreementsCru(ACORDO_COMPLETO);
    expect(r.campos).toContain("totalValue");
    expect(r.campos_parcela).toContain("documentNumber");
    expect(JSON.stringify([r.campos, r.campos_parcela])).not.toMatch(/3975|50719|429/);
  });

  it("o payload não é repassado adiante: forma do retorno travada", () => {
    const r = resumirAgreementsCru(ACORDO_COMPLETO);
    expect(Object.keys(r).sort()).toEqual([
      "acordos", "campos", "campos_no_topo", "campos_parcela", "forma_reconhecida",
      "parcelas", "parcelas_nao_pagas", "parcelas_pagas", "situacao_conhecida",
      "tem_lista_parcelas",
    ]);
  });

  it("CPF e nome, se vierem no acordo, saem só como NOME de campo", () => {
    const r = resumirAgreementsCru([
      { id: 1, cpf: "111.222.333-44", studentName: "Aluno Sintetico", registration: "2025007862" },
    ]);
    expect(r.campos).toEqual(["cpf", "id", "registration", "studentName"]);
    const texto = JSON.stringify(r);
    expect(texto).not.toMatch(/111\.222\.333-44/);
    expect(texto).not.toMatch(/Aluno Sintetico/);
    expect(texto).not.toMatch(/2025007862/);
  });
});

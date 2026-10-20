// Parte pura do painel de diagnóstico da Prime.
//
// O que estes testes prendem, em ordem de gravidade:
//   1. a allowlist do cliente é CÓPIA FIEL da do servidor (lê portao.ts e
//      compara) -- se alguém mudar um lado, isto quebra e diz qual;
//   2. o caminho é montado a partir do seletor, e não de texto livre;
//   3. ".." e "//" são recusados ANTES de olhar a lista, como no servidor;
//   4. o agregado NUNCA devolve valor de campo de item -- só contagem e nome
//      de campo. É requisito de privacidade: a resposta da ULBRA traz nome e
//      CPF, e a `forma` que a sonda devolve sem `cru` traz valor de escalar;
//   5. a comparação 1×2 é o objetivo da tela, e falta de resposta é `null`,
//      nunca "idênticas".
//
// Datas das fixtures são fixas de propósito (máquina em BRT, CI em UTC).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CAMINHOS_PERMITIDOS,
  CARRIER_DO_ACORDO,
  FORMAS,
  PERMITIDOS_LEGIVEL,
  agregarCorpo,
  agregarResposta,
  caminhoPermitido,
  diferencasDeAgregado,
  montarCaminho,
  motivoDaRecusa,
  osQuatroCaminhos,
  respostasIdenticas,
} from "./primeSonda";

const PORTAO = readFileSync(
  new URL("../../supabase/functions/prime-sonda/portao.ts", import.meta.url),
  "utf8",
);

function blocoEntre(texto, abre, fecha) {
  const i = texto.indexOf(abre);
  expect(i).toBeGreaterThan(-1);
  const j = texto.indexOf(fecha, i);
  expect(j).toBeGreaterThan(i);
  return texto.slice(i + abre.length, j);
}

describe("a allowlist do cliente espelha a do servidor", () => {
  it("os seis padrões são os mesmos, na mesma ordem", () => {
    const bloco = blocoEntre(PORTAO, "export const CAMINHOS_PERMITIDOS: RegExp[] = [", "];");
    const doServidor = bloco
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => l.startsWith("/"));
    expect(doServidor.length).toBe(6);
    expect(CAMINHOS_PERMITIDOS.map(String)).toEqual(doServidor);
  });

  it("a lista legível é a mesma", () => {
    const bloco = blocoEntre(PORTAO, "export const PERMITIDOS_LEGIVEL = [", "];");
    const doServidor = [...bloco.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(PERMITIDOS_LEGIVEL).toEqual(doServidor);
  });

  it("a recusa de '..' e '//' existe no servidor -- não é invenção do cliente", () => {
    expect(PORTAO).toContain('caminho.includes("..")');
    expect(PORTAO).toContain('caminho.includes("//")');
  });

  it("uma forma do seletor para cada caminho permitido", () => {
    expect(FORMAS.length).toBe(PERMITIDOS_LEGIVEL.length);
  });
});

describe("caminhoPermitido", () => {
  it("aceita exatamente as seis formas catalogadas", () => {
    for (const c of [
      "/carriers",
      "/carriers?take=200",
      "/students?search=Maria",
      "/students/232005643",
      "/students/232005643/contracts",
      "/students/232005643/financial-statement",
      "/students/232005643/financial-statement?carrierId=166",
      "/students/232005643/agreements",
    ]) expect(caminhoPermitido(c)).toBe(true);
  });

  it("recusa rota fora do catálogo, escrita, caminho relativo e barra dupla", () => {
    for (const c of [
      "/payments",
      "/students/232005643/titles",
      "/students/232005643/financial-statement/../../admin",
      "//students/232005643",
      "/students//financial-statement",
      "students/232005643",
      "",
      null,
      undefined,
    ]) expect(caminhoPermitido(c)).toBe(false);
  });

  it("o composto não aceita query string -- é o padrão do servidor", () => {
    expect(caminhoPermitido("/students/232005643")).toBe(true);
    expect(caminhoPermitido("/students/232005643?take=1")).toBe(false);
  });
});

describe("montar o caminho a partir do seletor", () => {
  it("monta as seis formas", () => {
    expect(montarCaminho({ forma: "carriers" })).toBe("/carriers");
    expect(montarCaminho({ forma: "carriers", query: "take=200" })).toBe("/carriers?take=200");
    expect(montarCaminho({ forma: "students_busca", query: "search=Maria" })).toBe("/students?search=Maria");
    expect(montarCaminho({ forma: "student_composite", matricula: "232005643" })).toBe("/students/232005643");
    expect(montarCaminho({ forma: "student_contracts", matricula: "232005643" })).toBe("/students/232005643/contracts");
    expect(montarCaminho({ forma: "financial_statement", matricula: "232005643" })).toBe("/students/232005643/financial-statement");
    expect(montarCaminho({ forma: "agreements", matricula: "232005643" })).toBe("/students/232005643/agreements");
  });

  it("aceita a query com ou sem o '?' que vem da barra do navegador", () => {
    const esperado = "/students/232005643/financial-statement?carrierId=166";
    expect(montarCaminho({ forma: "financial_statement", matricula: " 232005643 ", query: "carrierId=166" })).toBe(esperado);
    expect(montarCaminho({ forma: "financial_statement", matricula: "232005643", query: "?carrierId=166" })).toBe(esperado);
  });

  it("não conserta matrícula vazia em silêncio: monta o caminho que a allowlist recusa", () => {
    const c = montarCaminho({ forma: "financial_statement", matricula: "" });
    expect(c).toBe("/students//financial-statement");
    expect(caminhoPermitido(c)).toBe(false);
  });
});

describe("motivoDaRecusa explica, e só explica o que é verdade", () => {
  it("não recusa caminho válido", () => {
    expect(motivoDaRecusa({ forma: "financial_statement", matricula: "232005643" })).toBe("");
  });
  it("pede a matrícula quando a forma exige", () => {
    expect(motivoDaRecusa({ forma: "agreements", matricula: "" })).toMatch(/matrícula/i);
  });
  it("recusa matrícula com caractere fora do padrão do servidor", () => {
    expect(motivoDaRecusa({ forma: "agreements", matricula: "2320/5643" })).toMatch(/letras, números/i);
  });
  it("exige query na busca de aluno", () => {
    expect(motivoDaRecusa({ forma: "students_busca", query: "" })).toMatch(/query string/i);
  });
  it("avisa que o composto não aceita query", () => {
    expect(motivoDaRecusa({ forma: "student_composite", matricula: "232005643", query: "take=1" }))
      .toMatch(/não aceita query string/i);
  });
});

describe("os quatro testes da gestão", () => {
  it("são exatamente os quatro caminhos pedidos, nesta ordem", () => {
    expect(osQuatroCaminhos("232005643").map((t) => t.caminho)).toEqual([
      "/students/232005643/financial-statement",
      "/students/232005643/financial-statement?carrierId=166",
      "/students/232005643/agreements",
      "/students/232005643",
    ]);
    expect(CARRIER_DO_ACORDO).toBe(166);
  });
  it("os quatro passam pela allowlist", () => {
    for (const t of osQuatroCaminhos("232005643")) expect(caminhoPermitido(t.caminho)).toBe(true);
  });
});

// A FORMA DA RESPOSTA é a documentada em docs/integracoes/prime-api.md
// (13 campos do extrato). Os valores abaixo são inventados; o que o teste usa é
// a estrutura.
const EXTRATO = {
  items: [
    {
      boleto: "4039712", documentNumber: "0104270450100",
      carrier: { id: 195, name: "REATIVA RECUPERACAO DE CREDITO" },
      dueDate: "2026-01-05", paymentDate: "2026-09-14",
      grossAmount: 550, discountAmount: 0, penaltyAmount: 0, interestAmount: null,
      honorariumAmount: 45, netAmount: 595, paidAmount: 1110.12, isAgreementInstallment: false,
    },
    {
      boleto: "4039713", documentNumber: "0104270450200",
      carrier: { id: 95, name: "ULBRA" },
      dueDate: "2026-02-05", paymentDate: "2026-02-01",
      grossAmount: 550, discountAmount: 0, penaltyAmount: 0, interestAmount: null,
      honorariumAmount: 0, netAmount: 550, paidAmount: 1100, isAgreementInstallment: false,
    },
    {
      boleto: "4039714", documentNumber: "0556290001",
      carrier: { id: 166, name: "CONVENIO ACORDO" },
      dueDate: "2026-03-05", paymentDate: "2026-03-01",
      grossAmount: 300, discountAmount: 0, penaltyAmount: 0, interestAmount: null,
      honorariumAmount: 0, netAmount: 300, paidAmount: 300, isAgreementInstallment: true,
    },
  ],
  totalItems: 3,
};

describe("o agregado conta, e não revela", () => {
  it("conta itens, portador e parcela de acordo", () => {
    const ag = agregarCorpo(EXTRATO);
    expect(ag.itens).toBe(3);
    expect(ag.totalItens).toBe(3);
    expect(ag.parcelaDeAcordo).toBe(1);
    expect(ag.porCarrier).toEqual([
      { id: "166", nome: "CONVENIO ACORDO", n: 1 },
      { id: "195", nome: "REATIVA RECUPERACAO DE CREDITO", n: 1 },
      { id: "95", nome: "ULBRA", n: 1 },
    ]);
  });

  it("devolve NOMES de campo do primeiro item, e nenhum valor", () => {
    const ag = agregarCorpo(EXTRATO);
    expect(ag.campos).toEqual([
      "boleto", "documentNumber", "carrier", "dueDate", "paymentDate", "grossAmount",
      "discountAmount", "penaltyAmount", "interestAmount", "honorariumAmount",
      "netAmount", "paidAmount", "isAgreementInstallment",
    ]);
    // nenhum valor de item vaza para dentro do agregado
    const texto = JSON.stringify(ag);
    for (const valor of ["4039712", "0104270450100", "2026-01-05", "1110.12", "595"]) {
      expect(texto).not.toContain(valor);
    }
  });

  it("`agreements` vazio é resposta válida, contada como zero", () => {
    const ag = agregarCorpo({ items: [], totalItems: 0 });
    expect(ag.itens).toBe(0);
    expect(ag.totalItens).toBe(0);
    expect(ag.porCarrier).toEqual([]);
    expect(ag.campos).toEqual([]);
  });

  it("no composto, cada chave de topo vira bloco contado", () => {
    const ag = agregarCorpo({
      registrationData: { registration: "232005643", fullName: "NOME DE TESTE" },
      contracts: { items: [{ number: "", status: "Confirmado" }], totalItems: 1 },
      financialStatement: EXTRATO,
      agreements: { items: [], totalItems: 0 },
    });
    expect(ag.chavesDeTopo).toEqual(["registrationData", "contracts", "financialStatement", "agreements"]);
    const porChave = Object.fromEntries(ag.blocos.map((b) => [b.chave, b]));
    expect(porChave.financialStatement.itens).toBe(3);
    expect(porChave.financialStatement.parcelaDeAcordo).toBe(1);
    expect(porChave.agreements.itens).toBe(0);
    // registrationData é objeto: só os NOMES dos campos, nunca o nome da pessoa
    expect(porChave.registrationData.campos).toEqual(["registration", "fullName"]);
    expect(JSON.stringify(ag)).not.toContain("NOME DE TESTE");
  });

  it("agregarResposta IGNORA `forma` -- é ela que carrega valor de escalar", () => {
    const ag = agregarResposta({
      caminho: "/students/232005643/financial-statement",
      status: 200,
      tipo: "application/json; charset=utf-8",
      tamanho: 4120,
      // `forma` da sonda devolve VALORES truncados em 60 chars -- aqui vem um
      // nome de pessoa, de propósito, para provar que o agregado não o usa.
      forma: { items: { _lista: 3, _item: { boleto: "4039712", nome: "NOME DE TESTE" } }, totalItems: "3" },
      cru: EXTRATO,
    });
    expect(ag.statusPrime).toBe(200);
    expect(ag.tamanho).toBe(4120);
    expect(ag.itens).toBe(3);
    expect(JSON.stringify(ag)).not.toContain("NOME DE TESTE");
  });
});

describe("a comparação 1 × 2", () => {
  it("respostas iguais, com chaves em ordem diferente, são idênticas", () => {
    const a = { items: [{ boleto: "1", carrier: { id: 195, name: "R" } }], totalItems: 1 };
    const b = { totalItems: 1, items: [{ carrier: { name: "R", id: 195 }, boleto: "1" }] };
    expect(respostasIdenticas(a, b)).toBe(true);
  });

  it("um item a menos não é idêntico", () => {
    const menor = { items: EXTRATO.items.slice(0, 2), totalItems: 2 };
    expect(respostasIdenticas(EXTRATO, menor)).toBe(false);
  });

  it("ordem diferente dos itens não é idêntica", () => {
    const trocado = { items: [EXTRATO.items[1], EXTRATO.items[0], EXTRATO.items[2]], totalItems: 3 };
    expect(respostasIdenticas(EXTRATO, trocado)).toBe(false);
  });

  it("falta de resposta é `null` -- nunca 'idênticas'", () => {
    expect(respostasIdenticas(null, EXTRATO)).toBe(null);
    expect(respostasIdenticas(EXTRATO, undefined)).toBe(null);
    expect(respostasIdenticas(null, null)).toBe(null);
  });

  it("as diferenças são ditas por contagem, sem valor", () => {
    const menor = { items: EXTRATO.items.slice(0, 1), totalItems: 1 };
    const d = diferencasDeAgregado(agregarCorpo(EXTRATO), agregarCorpo(menor));
    expect(d.join(" | ")).toMatch(/itens: 3 × 1/);
    expect(d.join(" | ")).toMatch(/portador 166: 1 × 0/);
    expect(d.join(" | ")).not.toContain("4039712");
  });
});

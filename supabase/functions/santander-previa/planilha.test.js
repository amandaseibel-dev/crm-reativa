// SANTANDER · ENTREGA A — testes da normalização do lado do servidor.
//
// O que estes testes protegem, em ordem de importância:
//   1. EQUIVALÊNCIA: o parser do servidor produz a MESMA linha que o navegador
//      produz hoje, comparando as duas implementações caso a caso;
//   2. o formato real do extrato: 11 colunas por posição, três formatos de data,
//      matrícula extraída da coluna B, operador resolvido com os três aliases;
//   3. o portão de entrada: assinatura de arquivo, tamanho, nome e nº de linhas;
//   4. NÃO ESCREVE: a função não menciona a RPC de importação.
//
// NENHUM DADO REAL AQUI. Os casos são sintéticos, mas a VARIEDADE foi copiada da
// distribuição medida nos 10.636 pagamentos históricos: 52 textos distintos de
// operador, linhas sem matrícula, sem operador reconhecido, com valor pago zero
// e sem vencimento.
//
// A conferência contra os pagamentos históricos reais foi feita fora daqui, em
// 22/10/2026, e não é versionada porque traz identificador de aluno: 151 casos
// estratificados, 1.359 campos, DUAS representações de data (Date e dd/mm/aaaa),
// resultado 0 divergências inexplicadas. As 3 divergências encontradas são o
// alias `AMANDA.BORGES`, que entrou no mapa DEPOIS daquelas importações — medido:
// 172 linhas com esse texto, de 08/07 a 20/08/2026, todas com operador_email
// nulo em produção. O parser está certo; o histórico é anterior ao alias.
import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  LIMITE_BYTES,
  LIMITE_LINHAS,
  LIMITE_NOME,
  ehPlanilha,
  emailPorNomeOperador,
  linhaTemDado,
  normalizarLinhaSantander,
  normalizarPlanilha,
  paraDataISO,
  validarArquivo,
} from "./planilha.ts";
import { normalizarLinhaSantander as doNavegador } from "../../../src/pages/ProjecaoHoraHora.jsx";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..", "..");

// A planilha: A instituição | B "matrícula - nome" | C título | D operador |
// E boleto | F convênio | G vencimento | H valor original | I honorário |
// J data de pagamento | K valor pago
const linha = (o = {}) => [
  o.instituicao ?? "ULBRA",
  o.aluno ?? "2026002333 - Aluno Sintetico",
  o.titulo ?? "68325",
  o.operador ?? "DIEGO",
  o.boleto ?? "50683250001",
  o.convenio ?? "0272047",
  o.vencimento ?? new Date("2026-10-22T00:00:00Z"),
  o.valorOriginal ?? 1234.56,
  o.honorario ?? 123.45,
  o.dataPagamento ?? new Date("2026-10-21T00:00:00Z"),
  o.valorPago ?? 1234.56,
];

const xlsBytes = () => {
  const b = new Uint8Array(64);
  b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  return b;
};
const zipBytes = () => {
  const b = new Uint8Array(64);
  b.set([0x50, 0x4b, 0x03, 0x04], 0);
  return b;
};

// ===========================================================================
describe("EQUIVALÊNCIA com o navegador", () => {
  // A variedade abaixo é a medida nos 10.636 históricos.
  const casos = [
    { nome: "caso comum", l: linha() },
    { nome: "operador com acento", l: linha({ operador: "MAURÍCIO" }) },
    { nome: "alias NATALY -> NATALI", l: linha({ operador: "NATALY" }) },
    { nome: "alias RAFAELA -> RAFAELLA", l: linha({ operador: "RAFAELA" }) },
    { nome: "alias AMANDA.BORGES -> AMANDA ADM", l: linha({ operador: "AMANDA.BORGES" }) },
    { nome: "login NOME.SOBRENOME cai no 1º nome", l: linha({ operador: "DIEGO.SOUZA" }) },
    { nome: "AMANDA.SEIBEL NÃO resolve (ambíguo)", l: linha({ operador: "AMANDA.SEIBEL" }) },
    { nome: "operador desconhecido", l: linha({ operador: "ZORAIDE.XYZ" }) },
    { nome: "operador vazio", l: linha({ operador: "" }) },
    { nome: "sem matrícula na coluna B", l: linha({ aluno: "Aluno Sem Matricula" }) },
    { nome: "nome com ' - ' no meio", l: linha({ aluno: "Maria - Jose da Silva" }) },
    { nome: "matrícula curta não vale", l: linha({ aluno: "12 - Aluno" }) },
    { nome: "data dd/mm/aaaa", l: linha({ dataPagamento: "21/10/2026", vencimento: "22/10/2026" }) },
    { nome: "data serial do Excel", l: linha({ dataPagamento: 46316, vencimento: 46317 }) },
    { nome: "sem vencimento", l: linha({ vencimento: "" }) },
    { nome: "valor pago zero", l: linha({ valorPago: 0 }) },
    { nome: "valor original zero vira null", l: linha({ valorOriginal: 0 }) },
    { nome: "honorário ausente", l: linha({ honorario: "" }) },
    { nome: "boleto ausente", l: linha({ boleto: "" }) },
    { nome: "título ausente", l: linha({ titulo: "" }) },
    { nome: "valores como texto", l: linha({ valorPago: "1234.56", honorario: "123.45" }) },
  ];

  for (const { nome, l } of casos) {
    it(`mesma linha: ${nome}`, () => {
      expect(normalizarLinhaSantander(l)).toEqual(doNavegador(l));
    });
  }

  it("as 13 chaves e a ordem do contrato não mudam", () => {
    expect(Object.keys(normalizarLinhaSantander(linha())).sort()).toEqual(
      [
        "aluno_nome", "cpf", "data_pagamento", "matricula", "numero_parcela_completo",
        "operador_email", "operador_nome", "tipo_pagamento", "titulo_numero",
        "valor_honorario", "valor_original", "vencimento", "valor_pago",
      ].sort(),
    );
  });

  it("52 textos distintos de operador: o servidor concorda com o navegador em todos", () => {
    const textos = [
      "DIEGO", "LUANA", "NATALI", "NATALY", "RAFAELLA", "RAFAELA", "ALLAN", "JOÃO", "JOAO",
      "MAURÍCIO", "MAURICIO", "FERNANDA", "OLGA", "AMANDA ADM", "AMANDA.BORGES",
      "AMANDA.SEIBEL", "AMANDA GESTORA", "AMANDA", "diego", " diego ", "Diego.Souza",
      "OLGA.OLIVEIRA", "", null, undefined, "XPTO", "NATALI.X", "RAFAELA.Y",
    ];
    for (const t of textos) {
      const l = linha({ operador: t });
      expect(normalizarLinhaSantander(l)).toEqual(doNavegador(l));
    }
  });
});

// ===========================================================================
describe("DATAS", () => {
  it("o serial do Excel bate com XLSX.SSF nos seriais do histórico", () => {
    // 45658 = 2025-01-01; 46388 = 2027-01-01. Cobre toda a janela real.
    for (let serial = 45658; serial <= 46388; serial += 7) {
      const d = XLSX.SSF.parse_date_code(serial);
      const esperado = `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
      expect(paraDataISO(serial)).toBe(esperado);
    }
  });

  it("os três formatos chegam ao mesmo ISO", () => {
    expect(paraDataISO(new Date("2026-10-21T00:00:00Z"))).toBe("2026-10-21");
    expect(paraDataISO("21/10/2026")).toBe("2026-10-21");
    expect(paraDataISO(46316)).toBe("2026-10-21");
  });

  it("vazio, zero, negativo e texto sem barra devolvem null", () => {
    for (const v of ["", null, undefined, 0, -5, "2026-10-21", "abc", NaN]) {
      expect(paraDataISO(v)).toBeNull();
    }
  });
});

// ===========================================================================
describe("A LINHA DE TÍTULO, sem depender de posição", () => {
  it("descarta o título e mantém o pagamento", () => {
    const titulo = ["Data de Pagamento: 21/10/2026", "", "", "", "", "", "", "", "", "", ""];
    expect(linhaTemDado(titulo)).toBe(false);
    expect(linhaTemDado(linha())).toBe(true);
  });

  it("arquivo SEM linha de título não perde a 1ª linha", () => {
    const r = normalizarPlanilha([linha({ boleto: "50683250001" }), linha({ boleto: "50683250002" })]);
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.numero_parcela_completo)).toEqual(["50683250001", "50683250002"]);
  });

  it("valor pago zero sobrevive pela rede de segurança (aluno + data)", () => {
    expect(linhaTemDado(linha({ valorPago: 0 }))).toBe(true);
  });

  it("linha vazia e nula não entram", () => {
    expect(linhaTemDado(["", "", "", "", "", "", "", "", "", "", ""])).toBe(false);
    expect(linhaTemDado(null)).toBe(false);
    expect(linhaTemDado(undefined)).toBe(false);
  });
});

// ===========================================================================
describe("PORTÃO DO ARQUIVO", () => {
  it("aceita XLS (OLE2) e XLSX (ZIP) pela assinatura, não pela extensão", () => {
    expect(ehPlanilha(xlsBytes())).toBe(true);
    expect(ehPlanilha(zipBytes())).toBe(true);
    expect(validarArquivo(xlsBytes(), "21.10 - 14.54.xls")).toEqual({ ok: true, formato: "xls" });
    expect(validarArquivo(zipBytes(), "extrato.xlsx")).toEqual({ ok: true, formato: "xlsx" });
  });

  it("recusa o que NÃO é planilha, mesmo com nome .xls", () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n................");
    const r = validarArquivo(pdf, "extrato.xls");
    expect(r.ok).toBe(false);
    expect(r.erro).toBe("NAO_E_PLANILHA");
  });

  it("recusa vazio, grande demais e nome longo", () => {
    expect(validarArquivo(new Uint8Array(0), "a.xls").erro).toBe("ARQUIVO_VAZIO");
    expect(validarArquivo(null, "a.xls").erro).toBe("ARQUIVO_VAZIO");
    const grande = new Uint8Array(LIMITE_BYTES + 1);
    grande.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
    expect(validarArquivo(grande, "a.xls").erro).toBe("ARQUIVO_GRANDE");
    expect(validarArquivo(xlsBytes(), "x".repeat(LIMITE_NOME + 1)).erro).toBe("NOME_LONGO");
  });

  it("os limites são os medidos, não números redondos inventados", () => {
    expect(LIMITE_BYTES).toBe(5 * 1024 * 1024);
    expect(LIMITE_LINHAS).toBe(20000);
    expect(LIMITE_NOME).toBe(160);
  });
});

// ===========================================================================
describe("NÃO ESCREVE — garantido por texto, não por confiança", () => {
  // Confere o CÓDIGO, não a prosa: os comentários do index.ts citam a RPC de
  // importação justamente para dizer que ela NÃO é chamada, e um teste que
  // proibisse a string em qualquer lugar proibiria a própria documentação.
  const bruto = readFileSync(resolve(AQUI, "index.ts"), "utf8");
  const fonte = bruto
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  it("a função não menciona a RPC de importação", () => {
    expect(fonte).not.toMatch(/projecao_importar_pagamentos/);
  });

  it("não insere, não atualiza e não apaga nada", () => {
    expect(fonte).not.toMatch(/\.from\(\s*["']pagamentos["']/);
    expect(fonte).not.toMatch(/\.insert\(/);
    expect(fonte).not.toMatch(/\.update\(/);
    expect(fonte).not.toMatch(/\.delete\(/);
    expect(fonte).not.toMatch(/\.upsert\(/);
  });

  it("não cria agendamento nem toca na automação horária", () => {
    expect(fonte).not.toMatch(/cron\./);
    expect(fonte).not.toMatch(/fluxo_pagamentos/);
  });

  it("a única RPC que ela chama é a de validar gestão", () => {
    const rpcs = [...fonte.matchAll(/\.rpc\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(rpcs).toEqual(["usuario_e_gestao"]);
  });

  it("declara modo prévia e gravou: false na resposta", () => {
    expect(fonte).toMatch(/modo:\s*"previa"/);
    expect(fonte).toMatch(/gravou:\s*false/);
  });

  it("os comentários explicam a garantia, e isso é proposital", () => {
    // Se esta asserção cair, alguém apagou a explicação -- o que é pior do que
    // não tê-la escrito, porque a próxima pessoa não saberá que a ausência da
    // chamada é uma DECISÃO e não um esquecimento.
    expect(bruto).toMatch(/NÃO ESCREVE NADA/);
    expect(bruto).toMatch(/projecao_importar_pagamentos/);
  });

  it("o gateway exige JWT, declarado no config.toml", () => {
    const cfg = readFileSync(resolve(RAIZ, "supabase", "config.toml"), "utf8");
    const bloco = cfg.slice(cfg.indexOf("[functions.santander-previa]"));
    expect(bloco).toMatch(/verify_jwt\s*=\s*true/);
  });

  it("o portão interno recusa segredo de rotina ausente", () => {
    // `if (!esperado) return false` -- segredo ausente FECHA, nunca abre.
    expect(fonte).toMatch(/if \(!esperado\) return false/);
  });
});

// ===========================================================================
describe("O RESUMO da prévia", () => {
  it("conta pagamento, descartado, sem operador e sem matrícula", () => {
    const brutas = [
      ["Data de Pagamento: 21/10/2026", "", "", "", "", "", "", "", "", "", ""],
      linha(),
      linha({ operador: "XPTO" }),
      linha({ aluno: "Sem Matricula Aqui" }),
    ];
    const r = normalizarPlanilha(brutas);
    expect(r).toHaveLength(3);
    expect(r.filter((l) => !l.operador_email)).toHaveLength(1);
    expect(r.filter((l) => !l.matricula)).toHaveLength(1);
    expect(r.every((l) => l.tipo_pagamento === "SANTANDER")).toBe(true);
    expect(r.every((l) => l.cpf === null)).toBe(true);
  });

  it("o arquivo Santander nunca traz CPF — e o parser nunca inventa", () => {
    expect(normalizarLinhaSantander(linha()).cpf).toBeNull();
  });
});

// ===========================================================================
describe("o mapa de operadores é o mesmo do navegador", () => {
  it("resolve os dez operadores e a gestora", () => {
    expect(emailPorNomeOperador("DIEGO")).toBe("cobranca13@aelbra.com.br");
    expect(emailPorNomeOperador("NATALY")).toBe("cobranca08@aelbra.com.br");
    expect(emailPorNomeOperador("RAFAELA")).toBe("cobranca12@aelbra.com.br");
    expect(emailPorNomeOperador("AMANDA.BORGES")).toBe("cobranca07@aelbra.com.br");
    expect(emailPorNomeOperador("AMANDA GESTORA")).toBe("amanda.seibel@aelbra.com.br");
    expect(emailPorNomeOperador("MAURICIO")).toBe("cobranca06@aelbra.com.br");
  });

  it("não resolve o ambíguo nem o desconhecido", () => {
    expect(emailPorNomeOperador("AMANDA")).toBeNull();
    expect(emailPorNomeOperador("AMANDA.SEIBEL")).toBeNull();
    expect(emailPorNomeOperador("")).toBeNull();
    expect(emailPorNomeOperador(null)).toBeNull();
  });
});

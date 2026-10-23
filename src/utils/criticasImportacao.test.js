import { describe, it, expect } from "vitest";
import {
  rotuloClasse, rotuloMotivo, tomDaClasse, agruparResumo, totalDeCriticas,
  temCritica, criticasParaCsv, nomeDoCsv, CLASSES, MOTIVOS,
  tituloDoResultado, avisoDeArquivo, semRegistroDeCritica,
} from "./criticasImportacao";

describe("classificacao das criticas", () => {
  it("as tres classes existem e NAO sao todas 'erro'", () => {
    expect(Object.keys(CLASSES).sort()).toEqual(["DUPLICIDADE", "IGNORADA_POR_REGRA", "REJEICAO"]);
    expect(rotuloClasse("REJEICAO")).toBe("Rejeitada");
    expect(rotuloClasse("DUPLICIDADE")).toBe("Duplicidade");
    expect(rotuloClasse("IGNORADA_POR_REGRA")).toBe("Ignorada por regra");
    // tons distintos: a tela nao pode pintar as tres igual
    const tons = new Set(["REJEICAO", "DUPLICIDADE", "IGNORADA_POR_REGRA"].map(tomDaClasse));
    expect(tons.size).toBe(3);
  });

  it("todo motivo do banco tem rotulo", () => {
    expect(Object.keys(MOTIVOS).sort()).toEqual([
      "acordo_duplicado_sinalizado", "cpf_quitado_recente", "divida_ja_representada",
      "documento_invalido", "titulo_ja_existe",
    ]);
  });

  it("motivo ou classe desconhecida nao quebra a tela", () => {
    expect(rotuloClasse("COISA_NOVA")).toBe("COISA_NOVA");
    expect(rotuloMotivo("motivo_novo")).toBe("motivo_novo");
    expect(rotuloClasse(null)).toBe("-");
    expect(tomDaClasse("COISA_NOVA")).toBe("cinza");
  });
});

describe("resumo", () => {
  const resumo = [
    { classe: "IGNORADA_POR_REGRA", motivo_codigo: "cpf_quitado_recente", total: 8 },
    { classe: "REJEICAO", motivo_codigo: "documento_invalido", total: 2 },
    { classe: "DUPLICIDADE", motivo_codigo: "titulo_ja_existe", total: 5 },
    { classe: "IGNORADA_POR_REGRA", motivo_codigo: "divida_ja_representada", total: 3 },
  ];

  it("agrupa por classe e poe rejeicao primeiro", () => {
    const g = agruparResumo(resumo);
    expect(g.map((c) => c.classe)).toEqual(["REJEICAO", "DUPLICIDADE", "IGNORADA_POR_REGRA"]);
    expect(g[2].total).toBe(11);
    expect(g[2].motivos.map((m) => m.motivo_codigo)).toEqual(["cpf_quitado_recente", "divida_ja_representada"]);
  });

  it("soma o total e responde se tem critica", () => {
    expect(totalDeCriticas(resumo)).toBe(18);
    expect(temCritica(resumo)).toBe(true);
    expect(temCritica([])).toBe(false);
    expect(temCritica(null)).toBe(false);
    expect(totalDeCriticas(null)).toBe(0);
  });
});

describe("exportacao para conferencia", () => {
  const linhas = [
    { classe: "REJEICAO", motivo_codigo: "documento_invalido", origem: "ARQUIVO",
      linha_numero: 42, documento: "TOTAL", acordo_ulbra: null, cpf_mascarado: null,
      nome: null, vencimento: null, valor: null, detectado_em: "2026-10-23T12:00:00Z" },
    { classe: "DUPLICIDADE", motivo_codigo: "titulo_ja_existe", origem: "SERVIDOR",
      linha_numero: null, documento: "050999990001", acordo_ulbra: null,
      cpf_mascarado: "037.***.***-14", nome: "Nome Com ; Ponto", vencimento: "2026-08-07",
      valor: 1316.1, detectado_em: "2026-10-23T12:00:00Z" },
  ];

  it("tem cabecalho e uma linha por critica", () => {
    const csv = criticasParaCsv(linhas);
    const l = csv.split("\r\n");
    expect(l).toHaveLength(3);
    expect(l[0].startsWith("classe;classe_rotulo;motivo_codigo")).toBe(true);
  });

  it("protege documento longo do Excel e escapa o separador", () => {
    const csv = criticasParaCsv(linhas);
    // 12 digitos viraria notacao cientifica sem a protecao
    expect(csv).toContain('"\t050999990001"');
    // nome com ; nao parte a coluna
    expect(csv).toContain('"Nome Com ; Ponto"');
  });

  it("nulo sai vazio, nao 'null'", () => {
    const csv = criticasParaCsv(linhas);
    expect(csv).not.toContain("null");
    expect(csv).not.toContain("undefined");
  });

  it("lista vazia exporta so o cabecalho", () => {
    expect(criticasParaCsv([]).split("\r\n")).toHaveLength(1);
    expect(criticasParaCsv(null).split("\r\n")).toHaveLength(1);
  });

  it("o nome do arquivo carrega o inicio do lote", () => {
    expect(nomeDoCsv("11111111-1111-4111-8111-111111111111")).toBe("criticas-importacao-acordos-11111111.csv");
    expect(nomeDoCsv(null)).toBe("criticas-importacao-acordos-sem-lote.csv");
  });
});

describe("o resultado da importacao nao finge sucesso", () => {
  it("sem critica, o titulo e o de sempre", () => {
    expect(tituloDoResultado(0)).toBe("Importacao concluida ✅");
    expect(tituloDoResultado(null)).toBe("Importacao concluida ✅");
    expect(tituloDoResultado(undefined)).toBe("Importacao concluida ✅");
  });

  it("com critica, o titulo DIZ quantas — nao da para ler como sucesso limpo", () => {
    expect(tituloDoResultado(1)).toBe("Importação concluída com 1 crítica");
    expect(tituloDoResultado(40)).toBe("Importação concluída com 40 críticas");
    expect(tituloDoResultado(1500)).toContain("1.500 críticas");
    expect(tituloDoResultado(40)).not.toContain("✅");
  });

  it("falha de armazenamento e DECLARADA, nunca suposta", () => {
    expect(avisoDeArquivo(false)).toBe("nao_preservado");
    expect(avisoDeArquivo(true)).toBe("preservado");
    // null = nao houve tentativa; nao e a mesma coisa que ter falhado
    expect(avisoDeArquivo(null)).toBe("sem_tentativa");
    expect(avisoDeArquivo(undefined)).toBe("sem_tentativa");
  });
});

describe("historico: ausencia de registro nao e ausencia de problema", () => {
  it("importacao anterior a 23/10/2026 nao tem registro de critica", () => {
    expect(semRegistroDeCritica("2026-10-22T23:59:59Z")).toBe(true);
    expect(semRegistroDeCritica("2026-09-01T10:00:00Z")).toBe(true);
  });

  it("importacao a partir de 23/10/2026 tem", () => {
    expect(semRegistroDeCritica("2026-10-23T00:00:01Z")).toBe(false);
    expect(semRegistroDeCritica("2026-11-05T10:00:00Z")).toBe(false);
  });

  it("data ausente ou invalida cai no lado seguro (sem registro)", () => {
    expect(semRegistroDeCritica(null)).toBe(true);
    expect(semRegistroDeCritica("")).toBe(true);
    expect(semRegistroDeCritica("nao e data")).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import {
  CARTEIRA_GERAL_EMAIL,
  acordosDeTerceiros,
  agruparConflitos,
  classeEmAlerta,
  consolidarPorAno,
  rotuloClasse,
  validarConfirmacao,
} from "./carteiraGeral";

describe("Carteira Geral — destino", () => {
  it("o destino reservado não é um e-mail de pessoa", () => {
    // Se um dia virar um @aelbra.com.br, alguém pode criar login para ele e a
    // regra "sem senha compartilhada" cai por terra sem ninguém perceber.
    expect(CARTEIRA_GERAL_EMAIL).toBe("carteira.geral@reativa.local");
    expect(CARTEIRA_GERAL_EMAIL.endsWith("@aelbra.com.br")).toBe(false);
  });
});

describe("Carteira Geral — classe do responsável", () => {
  it("marca como alerta todo responsável que não é operador ativo", () => {
    expect(classeEmAlerta("SEM_OPERADOR")).toBe(true);
    expect(classeEmAlerta("INATIVO")).toBe(true);
    expect(classeEmAlerta("DESCONHECIDO")).toBe(true);
    // juridico@ e a própria gestão seguram casos sem ninguém da fila trabalhá-los
    expect(classeEmAlerta("NAO_OPERADOR")).toBe(true);
  });

  it("não marca operador ativo nem a própria Carteira Geral", () => {
    expect(classeEmAlerta("OPERADOR")).toBe(false);
    expect(classeEmAlerta("CARTEIRA_GERAL")).toBe(false);
    expect(rotuloClasse("CARTEIRA_GERAL")).toBe("Carteira Geral");
  });
});

describe("Carteira Geral — consolidação por ano", () => {
  const POR_ANO = [
    { ano: 2026, tipo: "ACORDO", alunos: 282, itens: 1051, valor: 1678901.67 },
    { ano: 2026, tipo: "MENSALIDADE", alunos: 254, itens: 699, valor: 681546.83 },
    { ano: 2025, tipo: "MENSALIDADE", alunos: 105, itens: 454, valor: 199401.35 },
  ];

  it("soma valor por ano e separa mensalidade de acordo", () => {
    const linhas = consolidarPorAno(POR_ANO);
    expect(linhas.map((l) => l.ano)).toEqual([2026, 2025]);

    const y2026 = linhas[0];
    expect(y2026.mensalidade).toBeCloseTo(681546.83, 2);
    expect(y2026.acordo).toBeCloseTo(1678901.67, 2);
    expect(y2026.valor).toBeCloseTo(2360448.5, 2);
    expect(y2026.itens).toBe(1750);
  });

  it("guarda a contagem de alunos por tipo, e não uma soma", () => {
    // 282 (acordo) + 254 (mensalidade) NÃO é 536 alunos: quem tem os dois conta
    // duas vezes. Somar aqui seria inventar carteira.
    const y2026 = consolidarPorAno(POR_ANO)[0];
    expect(y2026.alunosPorTipo).toEqual({ acordo: 282, mensalidade: 254 });
    expect(y2026).not.toHaveProperty("alunos");
  });

  it("aguenta entrada vazia ou inválida", () => {
    expect(consolidarPorAno(null)).toEqual([]);
    expect(consolidarPorAno([])).toEqual([]);
  });
});

describe("Carteira Geral — conflitos", () => {
  it("agrupa por tipo e conta, em vez de repetir a mesma linha", () => {
    const grupos = agruparConflitos([
      { tipo: "RETORNO_AGENDADO_SEGUE", nome: "A", detalhe: "a" },
      { tipo: "RETORNO_AGENDADO_SEGUE", nome: "B", detalhe: "b" },
      { tipo: "RETORNO_AGENDADO_SEGUE", nome: "C", detalhe: "c" },
      { tipo: "RETORNO_AGENDADO_SEGUE", nome: "D", detalhe: "d" },
      { tipo: "TITULARIDADE_DIVERGENTE", nome: "E", detalhe: "e" },
    ]);

    const retorno = grupos.find((g) => g.tipo === "RETORNO_AGENDADO_SEGUE");
    expect(retorno.total).toBe(4);
    expect(retorno.exemplos).toHaveLength(3); // amostra, não a lista inteira
  });

  it("põe o teto do operador acima dos avisos informativos", () => {
    const grupos = agruparConflitos([
      { tipo: "CASO_ENCERRADO", detalhe: "x" },
      { tipo: "TETO_DO_OPERADOR", detalhe: "y" },
      { tipo: "RETORNO_AGENDADO_SEGUE", detalhe: "z" },
    ]);
    expect(grupos[0].tipo).toBe("TETO_DO_OPERADOR");
    expect(grupos[grupos.length - 1].tipo).toBe("CASO_ENCERRADO");
  });

  it("dá nome em português para o acordo que fica para trás", () => {
    const [grupo] = agruparConflitos([{ tipo: "ACORDO_DO_DONO_FICA", detalhe: "x" }]);
    expect(grupo.rotulo).toMatch(/NÃO vai junto/);
  });
});

describe("Carteira Geral — acordos de terceiros", () => {
  const CONFLITOS = [
    { tipo: "RETORNO_AGENDADO_SEGUE", nome: "A", detalhe: "x" },
    { tipo: "ACORDO_DE_TERCEIRO_FICA", acordo_id: "ac-1", aluno_id: "al-1", nome: "MARIA",
      numero: "777", status: "ATIVO", valor: "1500.00", de_email: "cobranca05@aelbra.com.br" },
    { tipo: "ACORDO_DE_TERCEIRO_SELECIONADO", acordo_id: "ac-2", aluno_id: "al-2", nome: "JOAO",
      numero: "888", status: "ATIVO", valor: "9000.00", de_email: "cobranca06@aelbra.com.br" },
  ];

  it("extrai um item por acordo, com tudo que a gestão precisa para decidir", () => {
    const lista = acordosDeTerceiros(CONFLITOS);
    expect(lista).toHaveLength(2);
    // maior valor primeiro: é onde a decisão pesa
    expect(lista[0]).toMatchObject({
      acordo_id: "ac-2", aluno: "JOAO", numero: "888", status: "ATIVO",
      valor: 9000, de_email: "cobranca06@aelbra.com.br", selecionado: true,
    });
    expect(lista[1].selecionado).toBe(false);
  });

  it("não é agregado: 155 acordos viram 155 decisões, não uma", () => {
    const muitos = Array.from({ length: 155 }, (_, i) => ({
      tipo: "ACORDO_DE_TERCEIRO_FICA", acordo_id: `ac-${i}`, nome: "X", valor: String(i),
    }));
    expect(acordosDeTerceiros(muitos)).toHaveLength(155);
  });

  it("ignora conflito que não é de acordo de terceiro", () => {
    expect(acordosDeTerceiros([{ tipo: "CASO_ENCERRADO" }])).toEqual([]);
    expect(acordosDeTerceiros(null)).toEqual([]);
  });
});

describe("Carteira Geral — trava antes de confirmar", () => {
  const base = { destinoTipo: "CARTEIRA_GERAL", destinoEmail: null, motivo: "saída da Olga", selecionados: ["a"] };

  it("exige motivo, porque ele vai para a auditoria", () => {
    expect(validarConfirmacao({ ...base, motivo: "   " })).toEqual({
      ok: false,
      erro: "Informe o motivo — ele fica na auditoria.",
    });
  });

  it("exige seleção", () => {
    expect(validarConfirmacao({ ...base, selecionados: [] }).ok).toBe(false);
  });

  it("exige operador quando o destino é um operador", () => {
    expect(validarConfirmacao({ ...base, destinoTipo: "OPERADOR" }).ok).toBe(false);
    expect(
      validarConfirmacao({ ...base, destinoTipo: "OPERADOR", destinoEmail: "cobranca05@aelbra.com.br" }).ok
    ).toBe(true);
  });

  it("não exige operador para Carteira Geral nem para fila livre", () => {
    expect(validarConfirmacao(base).ok).toBe(true);
    expect(validarConfirmacao({ ...base, destinoTipo: "FILA_LIVRE" }).ok).toBe(true);
  });

  it("recusa destino que não existe", () => {
    expect(validarConfirmacao({ ...base, destinoTipo: "OLGA" }).ok).toBe(false);
  });
});

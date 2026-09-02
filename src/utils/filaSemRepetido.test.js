import { describe, it, expect } from "vitest";
import { cpfDaLinha, umaLinhaPorPessoa } from "./filaSemRepetido";

describe("umaLinhaPorPessoa", () => {
  it("o caso do print: a mesma linha nao sai duas vezes", () => {
    // Joao, 01/09/2026: Gabriela Moraes e Raquel Marques Kruse aparecendo
    // duas vezes seguidas, uma com o valor consolidado e outra com
    // "Revisar valor". No banco existe UM registro de cada.
    const fila = [
      { id: "a", cpf: "00955693080", nome: "Gabriela Moraes" },
      { id: "a", cpf: "00955693080", nome: "Gabriela Moraes" },
      { id: "b", cpf: "00768270030", nome: "Raquel Marques Kruse" },
      { id: "b", cpf: "00768270030", nome: "Raquel Marques Kruse" },
    ];

    expect(umaLinhaPorPessoa(fila).map((a) => a.nome)).toEqual([
      "Gabriela Moraes",
      "Raquel Marques Kruse",
    ]);
  });

  it("junta cadastro repetido pelo CPF, mesmo sem o zero a esquerda", () => {
    // `00892155086` x `892155086` foi duplicidade real na carga inicial.
    const fila = [
      { id: "copia", cpf: "892155086", nome: "Fulano de Tal", data_ultimo_acionamento: null, saldo_total: 0 },
      { id: "real", cpf: "00892155086", nome: "Fulano de Tal", data_ultimo_acionamento: "2026-08-20T11:41:22Z", saldo_total: 2308.08 },
    ];

    const fila2 = umaLinhaPorPessoa(fila);

    expect(fila2).toHaveLength(1);
    // Fica a que tem trabalho registrado -- e a que o operador reconhece.
    expect(fila2[0].saldo_total).toBe(2308.08);
    expect(fila2[0]._duplicados).toBe(1);
  });

  it("empate no acionamento: fica a de maior saldo", () => {
    const fila = [
      { id: "a", cpf: "11144477735", nome: "Beltrano", saldo_total: 0, data_ultimo_acionamento: "2026-08-01T00:00:00Z" },
      { id: "b", cpf: "11144477735", nome: "Beltrano", saldo_total: 900, data_ultimo_acionamento: "2026-08-01T00:00:00Z" },
    ];

    expect(umaLinhaPorPessoa(fila)[0].saldo_total).toBe(900);
  });

  it("mesmo CPF com nome de OUTRA pessoa continua sendo duas linhas", () => {
    // Medido em 02/09/2026: em 9 dos 17 CPFs repetidos da base os dois
    // cadastros sao de pessoas diferentes -- CPF digitado errado. Juntar
    // apagaria da fila um devedor real de R$ 21 mil.
    const fila = [
      { id: "a", cpf: "04379295079", nome: "Franck Gasparoni de Vasconcelos Duarte", saldo_total: 21890.19 },
      { id: "b", cpf: "043.792.950-79", nome: "Maria Eduarda Suris Barreira", saldo_total: 6051.71 },
    ];

    const fila2 = umaLinhaPorPessoa(fila);

    expect(fila2).toHaveLength(2);
    expect(fila2.map((a) => a.saldo_total)).toEqual([21890.19, 6051.71]);
    // As duas avisam: o CPF de uma delas esta errado.
    expect(fila2.every((a) => a._cpfConflitante)).toBe(true);
  });

  it("reconhece a mesma pessoa mesmo com particula a mais no nome", () => {
    // Duplicidade real do Diego: "de Jesus" x "Jesus". As duas tem saldo, entao
    // ficam as duas -- mas reconhecidas como a MESMA pessoa (`_repetidoNaFila`),
    // e nao como CPF de outro aluno.
    const fila = [
      { id: "a", cpf: "37007459234", nome: "Maria do Socorro de Jesus Cabral Neves", saldo_total: 2249.67, data_ultimo_acionamento: "2026-08-13T00:00:00Z" },
      { id: "b", cpf: "370.074.592-34", nome: "Maria do Socorro Jesus Cabral Neves", saldo_total: 2624.61, data_ultimo_acionamento: "2026-08-22T00:00:00Z" },
    ];

    const fila2 = umaLinhaPorPessoa(fila);

    expect(fila2).toHaveLength(2);
    expect(fila2.every((a) => a._repetidoNaFila)).toBe(true);
    expect(fila2.every((a) => !a._cpfConflitante)).toBe(true);
  });

  it("casa pelo `nome_aluno` quando o `nome` diverge", () => {
    // 64 registros da base tem `nome_aluno` sobrescrito com o nome de outra
    // pessoa; basta um dos dois campos casar.
    const fila = [
      { id: "a", cpf: "11144477735", nome: "Ketellen Laguna", nome_aluno: "Ketellen Laguna" },
      { id: "b", cpf: "11144477735", nome: "nome errado na carga", nome_aluno: "Ketellen Laguna" },
    ];

    expect(umaLinhaPorPessoa(fila)).toHaveLength(1);
  });

  it("NAO esconde a segunda linha quando ela tem saldo proprio", () => {
    // Aigo Silva, 02/09/2026: mesma pessoa, mesmo CPF, R$ 4.072,31 com a
    // Rafaella e R$ 4.992,46 com o Diego -- acordo ATIVO nos dois cadastros,
    // entao a fusao no banco e recusada pela trava. Colapsar aqui sumiria com
    // R$ 4.992,46 da cobranca.
    const fila = [
      { id: "a", cpf: "00123570220", nome: "Aígo Silva", saldo_total: 4072.31, data_ultimo_acionamento: "2026-08-30T00:00:00Z" },
      { id: "b", cpf: "001.235.702-20", nome: "Aígo Silva", saldo_total: 4992.46, data_ultimo_acionamento: "2026-08-31T00:00:00Z" },
    ];

    const fila2 = umaLinhaPorPessoa(fila);

    expect(fila2).toHaveLength(2);
    expect(fila2.map((a) => a.saldo_total)).toEqual([4072.31, 4992.46]);
    expect(fila2.every((a) => a._repetidoNaFila)).toBe(true);
    expect(fila2.every((a) => !a._duplicados)).toBe(true);
  });

  it("colapsa quando a linha absorvida so tem residuo (< R$ 5)", () => {
    const fila = [
      { id: "a", cpf: "11144477735", nome: "Fulano", saldo_total: 900, data_ultimo_acionamento: "2026-08-30T00:00:00Z" },
      { id: "b", cpf: "11144477735", nome: "Fulano", saldo_total: 4.9, data_ultimo_acionamento: "2026-08-20T00:00:00Z" },
    ];

    const fila2 = umaLinhaPorPessoa(fila);

    expect(fila2).toHaveLength(1);
    expect(fila2[0].saldo_total).toBe(900);
    expect(fila2[0]._duplicados).toBe(1);
  });

  it("homonimo com CPF diferente CONTINUA sendo duas linhas", () => {
    // Sao duas Leticia Martini Bitencourt na base, com CPFs, telefones e
    // dividas diferentes. Esconder uma apagaria cobranca legitima da fila.
    const fila = [
      { id: "a", cpf: "04180792001", nome: "Leticia Martini Bitencourt", saldo_total: 1776.77 },
      { id: "b", cpf: "03102772056", nome: "Leticia Martini Bitencourt", saldo_total: 1525.06 },
    ];

    expect(umaLinhaPorPessoa(fila)).toHaveLength(2);
    expect(umaLinhaPorPessoa(fila).every((a) => !a._duplicados)).toBe(true);
  });

  it("nao agrupa por lixo no campo CPF", () => {
    // Ja existe registro com o NOME gravado dentro de `cpf`. Se isso virasse
    // chave, pessoas diferentes cairiam na mesma linha.
    const fila = [
      { id: "a", cpf: "Tarso Caliel Volpatto Marcuzzo", nome: "um" },
      { id: "b", cpf: "", nome: "dois" },
      { id: "c", cpf: null, nome: "tres" },
      { id: "d", nome: "quatro" },
    ];

    expect(umaLinhaPorPessoa(fila).map((a) => a.nome)).toEqual(["um", "dois", "tres", "quatro"]);
  });

  it("preserva a ordem da fila e ignora buracos na lista", () => {
    const fila = [null, { id: "z", cpf: "11111111111" }, undefined, { id: "y", cpf: "22222222222" }];

    expect(umaLinhaPorPessoa(fila).map((a) => a.id)).toEqual(["z", "y"]);
  });

  it("conta certo quando ha tres cadastros da mesma pessoa", () => {
    const fila = [
      { id: "a", cpf: "33333333333", nome: "Sicrano", nome_aluno: "jan", data_ultimo_acionamento: "2026-01-01T00:00:00Z" },
      { id: "b", cpf: "33333333333", nome: "Sicrano", nome_aluno: "mai", data_ultimo_acionamento: "2026-05-01T00:00:00Z" },
      { id: "c", cpf: "33333333333", nome: "Sicrano", nome_aluno: "mar", data_ultimo_acionamento: "2026-03-01T00:00:00Z" },
    ];

    const fila2 = umaLinhaPorPessoa(fila);

    expect(fila2).toHaveLength(1);
    expect(fila2[0].nome_aluno).toBe("mai");
    expect(fila2[0]._duplicados).toBe(2);
  });

  it("lista vazia ou ausente nao quebra a fila", () => {
    expect(umaLinhaPorPessoa([])).toEqual([]);
    expect(umaLinhaPorPessoa(undefined)).toEqual([]);
    expect(umaLinhaPorPessoa(null)).toEqual([]);
  });
});

describe("cpfDaLinha", () => {
  it("normaliza com zeros a esquerda", () => {
    expect(cpfDaLinha({ cpf: "892155086" })).toBe("00892155086");
    expect(cpfDaLinha({ cpf: "033.200.110-57" })).toBe("03320011057");
  });

  it("devolve vazio para o que nao e CPF", () => {
    expect(cpfDaLinha({ cpf: "Tarso Caliel Volpatto Marcuzzo" })).toBe("");
    expect(cpfDaLinha({ cpf: "1234" })).toBe("");
    expect(cpfDaLinha({})).toBe("");
    expect(cpfDaLinha(null)).toBe("");
  });
});

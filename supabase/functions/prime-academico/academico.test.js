// Testes da leitura da resposta de `students_search`.
//
// O que estes testes protegem:
//   1. a DISTINÇÃO entre os três desfechos. Achatar falha de rede em "sem
//      resultado" faria a tela dizer que o aluno não tem vínculo por causa de
//      um timeout -- é o erro mais caro possível aqui;
//   2. que o desfecho é calculado DEPOIS do filtro por CPF, senão uma busca que
//      só traz terceiros vira "COM_VINCULOS" com tabela vazia;
//   3. que a paginação não perde linha em silêncio.

import { describe, it, expect } from "vitest";
import {
  desfecho, devePedirMaisUma, formatarCpf, lerPagina,
  registrationDoCabecalho, vinculosDaResposta,
} from "./academico.ts";

const CPF = "111.111.111-11"; // ficticio
const linha = (o = {}) => ({ cpf: CPF, registration: "990100001", course: "A", ...o });

describe("formatarCpf", () => {
  it("formata, porque o search só encontra CPF com pontuação", () => {
    expect(formatarCpf("11111111111")).toBe(CPF);
    expect(formatarCpf(CPF)).toBe(CPF);
    expect(formatarCpf(" 111 111 111 11 ")).toBe(CPF);
  });
  it("recusa o que não é CPF em vez de mandar lixo para a API", () => {
    for (const v of [null, undefined, "", "123", "0212330209", "021233020901", "abc"]) {
      expect(formatarCpf(v), String(v)).toBeNull();
    }
  });
});

describe("lerPagina", () => {
  it("separa lista vazia de corpo ilegível", () => {
    expect(lerPagina({ items: [], totalItems: 0 })).toEqual({ items: [], totalItems: 0 });
    // `items: null` é "não entendi", e NÃO "não tem nada"
    for (const d of [null, {}, { items: null }, { items: "x" }, 42, "texto"]) {
      expect(lerPagina(d).items, JSON.stringify(d)).toBeNull();
    }
  });
  it("totalItems fica nulo quando a API não manda o número", () => {
    expect(lerPagina({ items: [] }).totalItems).toBeNull();
  });
});

describe("devePedirMaisUma — a paginação não pode perder linha", () => {
  it("pede mais quando a página veio cheia e ainda falta", () => {
    expect(devePedirMaisUma(50, 50, 50, 120, 500)).toBe(true);
  });
  it("para quando a página veio menor que o pedido (era a última)", () => {
    expect(devePedirMaisUma(70, 20, 50, null, 500)).toBe(false);
  });
  it("para quando a página veio vazia", () => {
    expect(devePedirMaisUma(50, 0, 50, null, 500)).toBe(false);
  });
  it("para quando já juntou o total anunciado", () => {
    expect(devePedirMaisUma(100, 50, 50, 100, 500)).toBe(false);
  });
  it("para no teto, para não girar para sempre se a API repetir a página", () => {
    expect(devePedirMaisUma(500, 50, 50, 99999, 500)).toBe(false);
  });
  it("continua quando a API não diz o total mas a página veio cheia", () => {
    // Sem `totalItems`, parar aqui perderia a página seguinte em silêncio.
    expect(devePedirMaisUma(50, 50, 50, null, 500)).toBe(true);
  });
});

describe("desfecho — calculado DEPOIS do filtro por CPF", () => {
  it("COM_VINCULOS só quando há linha DESTA pessoa", () => {
    expect(desfecho(null, false, [linha()])).toBe("COM_VINCULOS");
  });

  it("SEM_RESULTADO quando a API respondeu e sobrou zero após o filtro", () => {
    // Este é o caso que a versão anterior errava: `items` tinha linhas, mas
    // nenhuma da pessoa. Dizia COM_VINCULOS e mostrava tabela vazia.
    expect(desfecho(null, false, [])).toBe("SEM_RESULTADO");
  });

  it("FALHA_COMUNICACAO quando houve falha — e isto NÃO é 'sem resultado'", () => {
    for (const f of ["HTTP 500", "HTTP 401", "falha de rede: TypeError"]) {
      expect(desfecho(f, false, []), f).toBe("FALHA_COMUNICACAO");
    }
  });

  it("corpo ilegível é FALHA, nunca 'vazio'", () => {
    expect(desfecho(null, true, [])).toBe("FALHA_COMUNICACAO");
  });

  it("falha manda mesmo que tenham sobrado linhas de páginas anteriores", () => {
    // Página 1 veio, página 2 falhou: a lista está incompleta e não se sabe o
    // quanto. Gravar como COM_VINCULOS afirmaria uma lista completa.
    expect(desfecho("HTTP 503", false, [linha()])).toBe("FALHA_COMUNICACAO");
  });
});

describe("vinculosDaResposta", () => {
  it("preserva a ORDEM e todas as linhas, inclusive semelhantes com status diferentes", () => {
    // O caso real da matrícula 222007757: três vínculos com curso, campus e
    // turno idênticos e status diferentes. Nenhum pode desaparecer.
    const itens = [
      linha({ course: "COMÉRCIO EXTERIOR", campus: "EAD", shift: "AD", status: "Reopção de Curso" }),
      linha({ course: "COMÉRCIO EXTERIOR", campus: "EAD", shift: "AD", status: "Cancelado" }),
      linha({ course: "COMÉRCIO EXTERIOR", campus: "EAD", shift: "AD", status: null }),
    ];
    const v = vinculosDaResposta(itens, CPF);
    expect(v).toHaveLength(3);
    expect(v.map((x) => x.status)).toEqual(["Reopção de Curso", "Cancelado", null]);
  });

  it("descarta linha de OUTRA pessoa, porque o search é substring", () => {
    const v = vinculosDaResposta(
      [linha({ course: "A" }), linha({ cpf: "999.999.999-99", course: "B" })], CPF);
    expect(v).toHaveLength(1);
    expect(v[0].course).toBe("A");
  });

  it("busca que só traz terceiros sobra zero — e vira SEM_RESULTADO", () => {
    const v = vinculosDaResposta([linha({ cpf: "999.999.999-99" })], CPF);
    expect(v).toHaveLength(0);
    expect(desfecho(null, false, v)).toBe("SEM_RESULTADO");
  });

  it("compara CPF em dígitos, não em texto formatado", () => {
    expect(vinculosDaResposta([linha({ cpf: "11111111111" })], CPF)).toHaveLength(1);
  });

  it("guarda a matrícula EM CADA LINHA", () => {
    const v = vinculosDaResposta(
      [linha({ registration: "111" }), linha({ registration: "222" })], CPF);
    expect(v.map((x) => x.registration)).toEqual(["111", "222"]);
  });

  it("matrícula numérica vira texto, para não perder zero à esquerda na volta", () => {
    expect(vinculosDaResposta([linha({ registration: 990100001 })], CPF)[0].registration)
      .toBe("990100001");
  });

  it("guarda graduated e admissionYear sem derivar um do status", () => {
    // Caso real da 201008325: status 'Mudança de Campus' com graduated true.
    const v = vinculosDaResposta(
      [linha({ status: "Mudança de Campus", graduated: true, admissionYear: 2023 })], CPF);
    expect(v[0]).toMatchObject({ status: "Mudança de Campus", graduated: true, admissionYear: 2023 });
  });

  it("devolve lista vazia sem estourar quando não há linha nenhuma", () => {
    expect(vinculosDaResposta([], CPF)).toEqual([]);
  });
});

describe("registrationDoCabecalho", () => {
  it("preenche quando todas as linhas concordam", () => {
    expect(registrationDoCabecalho([{ registration: "1" }, { registration: "1" }])).toBe("1");
  });
  it("fica nulo quando divergem, em vez de escolher uma", () => {
    // A informação por linha é que manda; escolher aqui daria a impressão de
    // que a pessoa "tem" aquela matrícula.
    expect(registrationDoCabecalho([{ registration: "1" }, { registration: "2" }])).toBeNull();
  });
  it("fica nulo quando não há matrícula nenhuma", () => {
    expect(registrationDoCabecalho([{ registration: null }])).toBeNull();
  });
});

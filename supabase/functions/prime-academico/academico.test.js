// Testes da leitura da resposta de `students_search`.
//
// O que estes testes protegem: a DISTINÇÃO entre os três desfechos. Achatar
// falha de rede em "sem resultado" faria a tela dizer que o aluno não tem
// vínculo por causa de um timeout -- é o erro mais caro possível aqui.

import { describe, it, expect } from "vitest";
import { formatarCpf, resultadoDaResposta, vinculosDaResposta } from "./academico.ts";

describe("formatarCpf", () => {
  it("formata, porque o search só encontra CPF com pontuação", () => {
    expect(formatarCpf("02123302090")).toBe("021.233.020-90");
    expect(formatarCpf("021.233.020-90")).toBe("021.233.020-90");
    expect(formatarCpf(" 021 233 020 90 ")).toBe("021.233.020-90");
  });
  it("recusa o que não é CPF em vez de mandar lixo para a API", () => {
    for (const v of [null, undefined, "", "123", "0212330209", "021233020901", "abc"]) {
      expect(formatarCpf(v), String(v)).toBeNull();
    }
  });
});

describe("resultadoDaResposta — os três desfechos", () => {
  it("COM_VINCULOS quando a API respondeu com linhas", () => {
    const r = resultadoDaResposta({ items: [{ registration: "201008325" }], totalItems: 1 }, null);
    expect(r.resultado).toBe("COM_VINCULOS");
    expect(r.totalItems).toBe(1);
    expect(r.registration).toBe("201008325");
  });

  it("SEM_RESULTADO quando a API respondeu e não achou — e isto NÃO é falha", () => {
    const r = resultadoDaResposta({ items: [], totalItems: 0 }, null);
    expect(r.resultado).toBe("SEM_RESULTADO");
    expect(r.totalItems).toBe(0);
  });

  it("FALHA_COMUNICACAO quando houve falha — e isto NÃO é 'sem resultado'", () => {
    for (const f of ["HTTP 500", "HTTP 401", "falha de rede: TypeError", "resposta ilegivel (JSON invalido)"]) {
      const r = resultadoDaResposta(null, f);
      expect(r.resultado, f).toBe("FALHA_COMUNICACAO");
      expect(r.totalItems, f).toBeNull();
    }
  });

  it("200 com corpo ilegível é FALHA, nunca 'vazio'", () => {
    // Um 200 sem `items` array não diz que não há vínculo: diz que não se
    // entendeu a resposta. Tratar como vazio inventaria uma conclusão.
    for (const d of [null, {}, { items: null }, { items: "nada" }, { outro: 1 }, 42, "texto"]) {
      expect(resultadoDaResposta(d, null).resultado, JSON.stringify(d)).toBe("FALHA_COMUNICACAO");
    }
  });

  it("registration fica nulo quando as linhas discordam, em vez de escolher uma", () => {
    const r = resultadoDaResposta({ items: [{ registration: "1" }, { registration: "2" }] }, null);
    expect(r.resultado).toBe("COM_VINCULOS");
    expect(r.registration).toBeNull();
  });

  it("totalItems cai para o tamanho da lista quando a API não manda o número", () => {
    expect(resultadoDaResposta({ items: [{}, {}] }, null).totalItems).toBe(2);
  });
});

describe("vinculosDaResposta", () => {
  const CPF = "021.233.020-90";

  it("preserva a ORDEM e todas as linhas, inclusive semelhantes com status diferentes", () => {
    // O caso real da matrícula 222007757: três vínculos com curso, campus e
    // turno idênticos e status diferentes. Nenhum pode desaparecer.
    const items = [
      { cpf: CPF, course: "COMÉRCIO EXTERIOR", campus: "EAD", shift: "ENSINO A DISTANCIA", status: "Reopção de Curso" },
      { cpf: CPF, course: "COMÉRCIO EXTERIOR", campus: "EAD", shift: "ENSINO A DISTANCIA", status: "Cancelado" },
      { cpf: CPF, course: "COMÉRCIO EXTERIOR", campus: "EAD", shift: "ENSINO A DISTANCIA", status: null },
    ];
    const v = vinculosDaResposta({ items }, CPF);
    expect(v).toHaveLength(3);
    expect(v.map((x) => x.status)).toEqual(["Reopção de Curso", "Cancelado", null]);
  });

  it("descarta linha de OUTRA pessoa, porque o search é substring", () => {
    const items = [
      { cpf: CPF, course: "A", status: "Formado" },
      { cpf: "999.999.999-99", course: "B", status: "Trancado" },
    ];
    const v = vinculosDaResposta({ items }, CPF);
    expect(v).toHaveLength(1);
    expect(v[0].course).toBe("A");
  });

  it("compara CPF em dígitos, não em texto formatado", () => {
    const v = vinculosDaResposta({ items: [{ cpf: "02123302090", course: "A" }] }, CPF);
    expect(v).toHaveLength(1);
  });

  it("guarda graduated e admissionYear sem derivar um do status", () => {
    // Caso real da 201008325: status 'Mudança de Campus' com graduated true.
    const items = [{ cpf: CPF, course: "A", status: "Mudança de Campus", graduated: true, admissionYear: 2023 }];
    const v = vinculosDaResposta({ items }, CPF);
    expect(v[0]).toMatchObject({ status: "Mudança de Campus", graduated: true, admissionYear: 2023 });
  });

  it("devolve lista vazia sem estourar quando a resposta é ilegível", () => {
    for (const d of [null, {}, { items: null }, "texto", 7]) {
      expect(vinculosDaResposta(d, CPF)).toEqual([]);
    }
  });
});

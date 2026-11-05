// Vínculo que pode abrir consulta de atendimento: só ativo e confirmado por CPF.
// O cliente falso aplica os mesmos filtros que a consulta real (aluno_id,
// desvinculado_em is null, confianca = valor pedido), sobre linhas em memória.
import { describe, it, expect } from "vitest";
import { vinculoConfirmado } from "./atendimento.ts";

type Linha = {
  aluno_id: string;
  ulbra_cliente_id: string;
  confianca: string;
  desvinculado_em: string | null;
};

function clienteFalso(linhas: Linha[]) {
  return {
    from(tabela: string) {
      if (tabela !== "ulbra_vinculos") throw new Error("tabela inesperada: " + tabela);
      const filtros: Array<(l: Linha) => boolean> = [];
      const builder = {
        select: () => builder,
        eq(coluna: keyof Linha, valor: unknown) {
          filtros.push((l) => l[coluna] === valor);
          return builder;
        },
        is(coluna: keyof Linha, valor: unknown) {
          filtros.push((l) => l[coluna] === valor);
          return builder;
        },
        async maybeSingle() {
          const achados = linhas.filter((l) => filtros.every((f) => f(l)));
          const data = achados[0] ? { ulbra_cliente_id: achados[0].ulbra_cliente_id } : null;
          return { data, error: null };
        },
      };
      return builder;
    },
  };
}

const ALUNO = "7b1f8285-6b96-4a73-a7e0-cf00305179ac";
const CLIENTE = "691dd4ad5dbe7b715b96c8ee";

describe("ulbra-atendimento: vínculo que pode consultar atendimento", () => {
  it("vínculo legado por telefone (confianca 'alta') não abre consulta", async () => {
    const sb = clienteFalso([
      { aluno_id: ALUNO, ulbra_cliente_id: CLIENTE, confianca: "alta", desvinculado_em: null },
    ]);
    expect(await vinculoConfirmado(sb, ALUNO)).toBeNull();
  });

  it("vínculo ambíguo não abre consulta", async () => {
    const sb = clienteFalso([
      { aluno_id: ALUNO, ulbra_cliente_id: CLIENTE, confianca: "ambigua", desvinculado_em: null },
    ]);
    expect(await vinculoConfirmado(sb, ALUNO)).toBeNull();
  });

  it("vínculo confirmado por CPF ('alta_cpf') abre consulta", async () => {
    const sb = clienteFalso([
      { aluno_id: ALUNO, ulbra_cliente_id: CLIENTE, confianca: "alta_cpf", desvinculado_em: null },
    ]);
    expect(await vinculoConfirmado(sb, ALUNO)).toEqual({ ulbra_cliente_id: CLIENTE });
  });

  it("vínculo desvinculado não é aceito, mesmo confirmado por CPF", async () => {
    const sb = clienteFalso([
      {
        aluno_id: ALUNO,
        ulbra_cliente_id: CLIENTE,
        confianca: "alta_cpf",
        desvinculado_em: "2026-11-01T00:00:00Z",
      },
    ]);
    expect(await vinculoConfirmado(sb, ALUNO)).toBeNull();
  });

  it("aluno sem nenhum vínculo → null", async () => {
    const sb = clienteFalso([]);
    expect(await vinculoConfirmado(sb, ALUNO)).toBeNull();
  });

  it("não devolve vínculo de outro aluno", async () => {
    const sb = clienteFalso([
      { aluno_id: "outro", ulbra_cliente_id: CLIENTE, confianca: "alta_cpf", desvinculado_em: null },
    ]);
    expect(await vinculoConfirmado(sb, ALUNO)).toBeNull();
  });
});

// A prioridade que o operador marca na tabulacao (alunos.retorno_prioritario):
// onde ela pesa e, principalmente, onde ela NAO pesa.
import { describe, it, expect } from "vitest";
import { ordenarCasos, retornoPrioritarioDevido } from "./carteiraFila";
import { retornosAgendados, JANELA_RETORNOS_DIAS } from "./painelMeuDia";

const HOJE = "2026-10-15";
const caso = (o) => ({
  id: "a1",
  nome_aluno: "Aluna Um",
  data_ultimo_acionamento: "2026-10-14T10:00:00Z",
  nivel_criticidade: "MEDIA",
  data_retorno: HOJE,
  retorno_origem: "OPERADOR",
  retorno_prioritario: false,
  ...o,
});

describe("quando a prioridade vale", () => {
  it("vale no retorno devido (hoje ou atrasado)", () => {
    expect(retornoPrioritarioDevido(caso({ retorno_prioritario: true }), HOJE)).toBe(true);
    expect(retornoPrioritarioDevido(caso({ retorno_prioritario: true, data_retorno: "2026-10-14" }), HOJE)).toBe(true);
  });

  it("NAO vale antes da hora: retorno de sexta nao ocupa o topo na quinta", () => {
    expect(retornoPrioritarioDevido(caso({ retorno_prioritario: true, data_retorno: "2026-10-16" }), HOJE)).toBe(false);
  });

  it("NAO vale sem retorno marcado: a prioridade e do compromisso, nao do caso", () => {
    expect(retornoPrioritarioDevido(caso({ retorno_prioritario: true, data_retorno: null }), HOJE)).toBe(false);
    expect(retornoPrioritarioDevido(caso({ retorno_prioritario: false }), HOJE)).toBe(false);
  });
});

describe("efeito na fila", () => {
  const perdendo = caso({ id: "perdendo", data_ultimo_acionamento: "2026-09-20T10:00:00Z", data_retorno: null });
  const prioritario = caso({ id: "prioritario", retorno_prioritario: true });

  it("o marcado vem antes ate do caso em risco de perder, na fila inteligente", () => {
    const ordem = ordenarCasos([perdendo, prioritario], { ordenacao: "inteligente", hoje: HOJE }).map((a) => a.id);
    expect(ordem[0]).toBe("prioritario");
  });

  it("tambem manda na ordenacao 'prioridade (o que acionar)'", () => {
    const ordem = ordenarCasos([perdendo, prioritario], { ordenacao: "prioridade", hoje: HOJE }).map((a) => a.id);
    expect(ordem[0]).toBe("prioritario");
  });

  it("nao mexe em quem escolheu ordenar por valor ou por tempo sem contato", () => {
    const caro = caso({ id: "caro", valor_em_aberto: 90000, retorno_prioritario: false });
    const barato = caso({ id: "barato", valor_em_aberto: 10, retorno_prioritario: true });
    expect(ordenarCasos([barato, caro], { ordenacao: "valor_desc", hoje: HOJE })[0].id).toBe("caro");
  });

  it("marcado com retorno futuro nao sobe: a fila segue a regra de sempre", () => {
    const futuro = caso({ id: "futuro", retorno_prioritario: true, data_retorno: "2026-10-20" });
    const ordem = ordenarCasos([perdendo, futuro], { ordenacao: "inteligente", hoje: HOJE }).map((a) => a.id);
    expect(ordem[0]).toBe("perdendo");
  });
});

describe("efeito no bloco Meu dia", () => {
  it("dentro do mesmo dia o prioritario vem primeiro, mesmo com hora mais tarde", () => {
    const lista = retornosAgendados(
      [
        caso({ id: "cedo", hora_retorno: "09:00" }),
        caso({ id: "prioritario", hora_retorno: "17:00", retorno_prioritario: true }),
      ],
      HOJE,
      JANELA_RETORNOS_DIAS
    );
    expect(lista.map((r) => r.id)).toEqual(["prioritario", "cedo"]);
    expect(lista[0].prioritario).toBe(true);
  });

  it("prioridade nao fura a ordem ENTRE dias", () => {
    const lista = retornosAgendados(
      [
        caso({ id: "amanha-prioritario", data_retorno: "2026-10-16", retorno_prioritario: true }),
        caso({ id: "hoje-comum", hora_retorno: "17:00" }),
      ],
      HOJE,
      JANELA_RETORNOS_DIAS
    );
    expect(lista.map((r) => r.id)).toEqual(["hoje-comum", "amanha-prioritario"]);
  });
});

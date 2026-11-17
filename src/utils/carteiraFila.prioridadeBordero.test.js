import { describe, it, expect } from "vitest";
import {
  ordenarCasos,
  snapshotDoGuiado,
  ehPrioridadeBordero,
  excluidoDoGuiado,
  normCpfFila,
} from "./carteiraFila";

const CPF_A = "11111111111";
const CPF_B = "22222222222";
const CPF_C = "33333333333";
const CPF_D = "44444444444";

const base = (over) => ({
  elegivel: true,
  bloqueado: false,
  pagamento_pendente: false,
  sem_acionamento_desde_entrada: true,
  saldo_bordero_2026: 1000,
  ...over,
});

const mapa = {
  [CPF_A]: base({ saldo_bordero_2026: 100 }),
  [CPF_B]: base({ saldo_bordero_2026: 9000 }),
  [CPF_C]: base({ bloqueado: true }),
  [CPF_D]: base({ pagamento_pendente: true }),
};

const caso = (id, cpf) => ({ id, cpf, nome: `aluno ${id}` });

describe("normalização de CPF", () => {
  it("normaliza igual ao restante da tela", () => {
    expect(normCpfFila("123.456.789-01")).toBe("12345678901");
    expect(normCpfFila("123")).toBe("00000000123");
  });
});

describe("ehPrioridadeBordero", () => {
  it("aceita elegível, sem bloqueio, sem pagamento e sem acionamento desde a entrada", () => {
    expect(ehPrioridadeBordero(caso("a", CPF_A), mapa)).toBe(true);
  });
  it("recusa quem já foi acionado desde a entrada", () => {
    const m = { [CPF_A]: base({ sem_acionamento_desde_entrada: false }) };
    expect(ehPrioridadeBordero(caso("a", CPF_A), m)).toBe(false);
  });
  it("recusa saldo zero ou inelegível", () => {
    const m = { [CPF_A]: base({ saldo_bordero_2026: 0 }), [CPF_B]: base({ elegivel: false }) };
    expect(ehPrioridadeBordero(caso("a", CPF_A), m)).toBe(false);
    expect(ehPrioridadeBordero(caso("b", CPF_B), m)).toBe(false);
  });
  it("sem mapa ou fora do mapa não prioriza e não penaliza", () => {
    expect(ehPrioridadeBordero(caso("x", CPF_A), null)).toBe(false);
    expect(ehPrioridadeBordero(caso("x", "99999999999"), mapa)).toBe(false);
  });
});

describe("exclusão do guiado", () => {
  it("exclui bloqueado e pagamento pendente", () => {
    expect(excluidoDoGuiado(caso("c", CPF_C), mapa)).toBe(true);
    expect(excluidoDoGuiado(caso("d", CPF_D), mapa)).toBe(true);
    expect(excluidoDoGuiado(caso("a", CPF_A), mapa)).toBe(false);
  });
  it("snapshot do guiado não traz os excluídos e preserva a ordem visível", () => {
    const lista = [caso("c", CPF_C), caso("a", CPF_A), caso("d", CPF_D), caso("b", CPF_B)];
    expect(snapshotDoGuiado(lista, mapa)).toEqual(["a", "b"]);
  });
  it("sem mapa, o snapshot é o de antes (compatível)", () => {
    const lista = [caso("c", CPF_C), caso("a", CPF_A)];
    expect(snapshotDoGuiado(lista)).toEqual(["c", "a"]);
  });
});

describe("ordenação Fila inteligente", () => {
  it("coloca a prioridade de borderô à frente dentro da mesma faixa", () => {
    const lista = [caso("outro", "55555555555"), caso("a", CPF_A)];
    const ordenada = ordenarCasos(lista, { ordenacao: "inteligente", prioridadeBordero: mapa });
    expect(ordenada[0].id).toBe("a");
  });

  it("preserva ordenação escolhida manualmente", () => {
    const lista = [
      { id: "a", cpf: CPF_A, valor_em_aberto: 10 },
      { id: "b", cpf: CPF_B, valor_em_aberto: 500 },
    ];
    const porValor = ordenarCasos(lista, { ordenacao: "valor_asc", prioridadeBordero: mapa });
    expect(porValor.map((x) => x.id)).toEqual(["a", "b"]);
    const porValorDesc = ordenarCasos(lista, { ordenacao: "valor_desc", prioridadeBordero: mapa });
    expect(porValorDesc.map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("sem prioridadeBordero, a ordem inteligente não muda", () => {
    const lista = [caso("outro", "55555555555"), caso("a", CPF_A)];
    const sem = ordenarCasos(lista, { ordenacao: "inteligente" });
    const com = ordenarCasos(lista, { ordenacao: "inteligente", prioridadeBordero: null });
    expect(com.map((x) => x.id)).toEqual(sem.map((x) => x.id));
  });
});

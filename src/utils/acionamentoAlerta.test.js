// Regras de apresentacao da situacao de acionamento. Funcoes PURAS.
//
// O ponto que estes testes protegem: o rotulo fala do ALUNO, nunca da parcela.
// Nenhuma tabela de contato carrega parcela_id (conferido em producao em
// 21/10/2026), entao afirmar "esta parcela foi avisada" seria presumir.
import { describe, it, expect } from "vitest";
import {
  situacaoAcionamento, textoDias, textoVencimento, indiceAcionamento,
  ordenarPorAcionamento, PRIORIDADE, SEM_AVISO, NAO_ACIONADO,
} from "./acionamentoAlerta";

const HOJE = "2026-10-21";

describe("situacaoAcionamento: so afirma o que esta registrado", () => {
  it("sem caso sob operador nao ha de onde ler a data: indicacao NEUTRA", () => {
    const s = situacaoAcionamento({ dua: null, vencimento: "2026-10-10", hoje: HOJE, temCaso: false });
    expect(s.texto).toBe(SEM_AVISO);
    expect(s.acionado).toBe(false);
    expect(s.prioridade).toBe(PRIORIDADE.SEM_CASO);
  });

  it("caso sem data de acionamento => Nao acionado", () => {
    const s = situacaoAcionamento({ dua: null, vencimento: "2026-10-10", hoje: HOJE });
    expect(s.texto).toBe(NAO_ACIONADO);
    expect(s.prioridade).toBe(PRIORIDADE.NAO_ACIONADO);
  });

  it("acionado hoje", () => {
    expect(situacaoAcionamento({ dua: HOJE, vencimento: "2026-10-10", hoje: HOJE }).texto)
      .toBe("Acionado hoje · após o vencimento");
  });

  it("acionado ANTES do vencimento: aviso preventivo nao substitui o de depois", () => {
    const s = situacaoAcionamento({ dua: "2026-10-08", vencimento: "2026-10-15", hoje: HOJE });
    expect(s.texto).toBe("Acionado há 13 dias · antes do vencimento");
    // Fica em EVIDENCIA: so houve preventivo, o pos-vencimento nao aconteceu.
    expect(s.prioridade).toBe(PRIORIDADE.SO_ANTES);
  });

  it("acionado APOS o vencimento", () => {
    const s = situacaoAcionamento({ dua: "2026-10-18", vencimento: "2026-10-15", hoje: HOJE });
    expect(s.texto).toBe("Acionado há 3 dias · após o vencimento");
    expect(s.prioridade).toBe(PRIORIDADE.ACIONADO);
  });

  it("acionado NO DIA do vencimento: nao afirma antes nem depois", () => {
    const s = situacaoAcionamento({ dua: "2026-10-15", vencimento: "2026-10-15", hoje: HOJE });
    expect(s.texto).toBe("Acionado há 6 dias");
    expect(s.texto).not.toMatch(/antes|após/);
    expect(s.prioridade).toBe(PRIORIDADE.NO_DIA);
  });

  it("data futura ou ilegivel nao vira afirmacao: cai no neutro", () => {
    expect(situacaoAcionamento({ dua: "2026-12-01", vencimento: "2026-10-15", hoje: HOJE }).texto).toBe(SEM_AVISO);
    expect(situacaoAcionamento({ dua: "nao-e-data", vencimento: "2026-10-15", hoje: HOJE }).texto).toBe(SEM_AVISO);
  });

  it("sem vencimento conhecido, nao inventa o sufixo", () => {
    const s = situacaoAcionamento({ dua: "2026-10-18", vencimento: null, hoje: HOJE });
    expect(s.texto).toBe("Acionado há 3 dias");
  });

  it("um dia no singular", () => {
    expect(textoDias(1)).toBe("há 1 dia");
    expect(textoDias(0)).toBe("hoje");
    expect(textoDias(9)).toBe("há 9 dias");
  });
});

describe("textoVencimento: vencimento OU dias de atraso", () => {
  it("vencida usa dias de atraso, no singular e no plural", () => {
    expect(textoVencimento({ dias_restantes: -1 }, HOJE)).toBe("1 dia de atraso");
    expect(textoVencimento({ dias_restantes: -9 }, HOJE)).toBe("9 dias de atraso");
  });
  it("a vencer mantem o texto de sempre", () => {
    expect(textoVencimento({ dias_restantes: 0 }, HOJE)).toBe("vence hoje");
    expect(textoVencimento({ dias_restantes: 1 }, HOJE)).toBe("vence amanhã");
    expect(textoVencimento({ dias_restantes: 4 }, HOJE)).toBe("vence em 4 dias");
  });
  it("sem dias_restantes, calcula pela data", () => {
    expect(textoVencimento({ vencimento: "2026-10-12" }, HOJE)).toBe("9 dias de atraso");
  });
});

describe("indiceAcionamento: le a fila que a tela ja tem", () => {
  it("monta por aluno_id e fica com a data MAIS RECENTE quando ha dois casos", () => {
    const i = indiceAcionamento([
      { aluno_id: "a1", data_ultimo_acionamento: "2026-10-01" },
      { aluno_id: "a1", data_ultimo_acionamento: "2026-10-19" },
      { aluno_id: "a2", data_ultimo_acionamento: null },
    ]);
    expect(i.get("a1").dua).toBe("2026-10-19");
    expect(i.get("a2")).toEqual({ dua: null, temCaso: true });
    expect(i.get("a3")).toBeUndefined();
  });
  it("entrada vazia ou invalida nao quebra", () => {
    expect(indiceAcionamento(null).size).toBe(0);
    expect(indiceAcionamento([{}, { aluno_id: "" }]).size).toBe(0);
  });
});

describe("ordenarPorAcionamento: nao contraria a prioridade ja estabelecida", () => {
  const A = (id, venc) => ({ aluno_id: id, vencimento: venc, parcela_id: `p${id}`, acordo_id: `c${id}` });

  it("sem aviso comprovado sobe; dentro do grupo a ordem de entrada e preservada", () => {
    const lista = [A("comAviso", "2026-10-10"), A("semCaso", "2026-10-10"), A("semDua", "2026-10-10")];
    const indice = new Map([
      ["comAviso", { dua: "2026-10-18", temCaso: true }],
      ["semDua", { dua: null, temCaso: true }],
    ]);
    const r = ordenarPorAcionamento(lista, indice, HOJE);
    expect(r.map((x) => x.aluno_id)).toEqual(["semCaso", "semDua", "comAviso"]);
  });

  it("entre dois ja acionados, a ordem operacional de entrada NAO muda", () => {
    const lista = [A("x", "2026-10-10"), A("y", "2026-10-11")];
    const indice = new Map([
      ["x", { dua: "2026-10-18", temCaso: true }],
      ["y", { dua: "2026-10-19", temCaso: true }],
    ]);
    expect(ordenarPorAcionamento(lista, indice, HOJE).map((a) => a.aluno_id)).toEqual(["x", "y"]);
  });

  it("so preventivo fica acima de quem ja foi acionado depois do vencimento", () => {
    const lista = [A("depois", "2026-10-10"), A("soAntes", "2026-10-10")];
    const indice = new Map([
      ["depois", { dua: "2026-10-18", temCaso: true }],
      ["soAntes", { dua: "2026-10-05", temCaso: true }],
    ]);
    expect(ordenarPorAcionamento(lista, indice, HOJE).map((a) => a.aluno_id)).toEqual(["soAntes", "depois"]);
  });
});

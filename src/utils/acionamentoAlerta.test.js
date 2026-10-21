// Regras de apresentacao da situacao de acionamento. Funcoes PURAS.
//
// O ponto que estes testes protegem: o indicador fala do ALUNO, nunca da
// parcela. Nenhuma tabela de contato carrega parcela_id (conferido em producao
// em 21/10/2026), entao afirmar "esta parcela foi avisada" seria presumir.
import { describe, it, expect } from "vitest";
import {
  situacaoAcionamento, textoDias, textoVencimento, indiceAcionamento,
  ordenarPorAcionamento, PRIORIDADE, SEM_REGISTRO, CONTEXTO,
} from "./acionamentoAlerta";

const HOJE = "2026-10-21";

describe("situacaoAcionamento: texto curto, ressalva no contexto", () => {
  it("o contexto SEMPRE diz que e do aluno e que nao comprova a parcela", () => {
    for (const caso of [
      { dua: null, temCaso: false },
      { dua: null, temCaso: true },
      { dua: "2026-10-18", temCaso: true },
    ]) {
      const s = situacaoAcionamento({ ...caso, vencimento: "2026-10-15", hoje: HOJE });
      expect(s.detalhe).toContain(CONTEXTO);
      expect(s.detalhe).toMatch(/Não comprova aviso desta parcela/);
    }
  });

  it("so tres textos curtos existem: Hoje, Ha X dias, Sem registro", () => {
    expect(situacaoAcionamento({ dua: HOJE, vencimento: "2026-10-15", hoje: HOJE }).curto).toBe("Hoje");
    expect(situacaoAcionamento({ dua: "2026-10-18", vencimento: "2026-10-15", hoje: HOJE }).curto).toBe("Há 3 dias");
    expect(situacaoAcionamento({ dua: null, hoje: HOJE }).curto).toBe(SEM_REGISTRO);
    expect(situacaoAcionamento({ dua: null, hoje: HOJE, temCaso: false }).curto).toBe(SEM_REGISTRO);
  });

  it("sem caso e sem data dao o MESMO texto curto, e motivos diferentes no contexto", () => {
    const semCaso = situacaoAcionamento({ dua: null, hoje: HOJE, temCaso: false });
    const semData = situacaoAcionamento({ dua: null, hoje: HOJE, temCaso: true });
    expect(semCaso.curto).toBe(semData.curto);
    expect(semCaso.detalhe).toMatch(/Nenhum caso deste aluno está com operador/);
    expect(semData.detalhe).toMatch(/não tem data de acionamento registrada/);
    // Sem caso e pior: aparece antes no recorte compacto.
    expect(semCaso.prioridade).toBeLessThan(semData.prioridade);
  });

  it("o antes/apos vai para o CONTEXTO, nao para um segundo selo", () => {
    const antes = situacaoAcionamento({ dua: "2026-10-08", vencimento: "2026-10-15", hoje: HOJE });
    expect(antes.curto).toBe("Há 13 dias");
    expect(antes.curto).not.toMatch(/antes|após/);
    expect(antes.detalhe).toMatch(/Foi ANTES do vencimento \(15\/10\/2026\)/);
    expect(antes.prioridade).toBe(PRIORIDADE.SO_ANTES);

    const apos = situacaoAcionamento({ dua: "2026-10-18", vencimento: "2026-10-15", hoje: HOJE });
    expect(apos.detalhe).toMatch(/Foi APÓS o vencimento \(15\/10\/2026\)/);
    expect(apos.prioridade).toBe(PRIORIDADE.ACIONADO);
  });

  it("no proprio dia do vencimento nao afirma antes nem depois", () => {
    const s = situacaoAcionamento({ dua: "2026-10-15", vencimento: "2026-10-15", hoje: HOJE });
    expect(s.detalhe).toMatch(/no próprio dia do vencimento/);
    expect(s.detalhe).not.toMatch(/ANTES|APÓS/);
    expect(s.prioridade).toBe(PRIORIDADE.NO_DIA);
  });

  it("data futura ou ilegivel nao vira afirmacao", () => {
    expect(situacaoAcionamento({ dua: "2026-12-01", vencimento: "2026-10-15", hoje: HOJE }).curto).toBe(SEM_REGISTRO);
    expect(situacaoAcionamento({ dua: "nao-e-data", vencimento: "2026-10-15", hoje: HOJE }).curto).toBe(SEM_REGISTRO);
  });

  it("sem vencimento conhecido, o contexto nao inventa a comparacao", () => {
    const s = situacaoAcionamento({ dua: "2026-10-18", vencimento: null, hoje: HOJE });
    expect(s.curto).toBe("Há 3 dias");
    expect(s.detalhe).not.toMatch(/ANTES|APÓS|vencimento \(/);
  });

  it("um dia no singular", () => {
    expect(textoDias(1)).toBe("Há 1 dia");
    expect(textoDias(0)).toBe("Hoje");
    expect(textoDias(9)).toBe("Há 9 dias");
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

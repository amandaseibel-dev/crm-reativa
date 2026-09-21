import { describe, it, expect } from "vitest";
import { normalizarAlertas, rotuloDiasRestantes, formatarDataBR, formatarValorBRL, ordenarAlertas, descricaoAlerta, alertasDoAluno, chaveAlerta } from "./alertasParcela";

const A = (o) => ({ aluno_id: "a1", aluno_nome: "Aluna", acordo_id: "c1", numero_acordo: 10, parcela_id: "p1", numero_parcela: 2, valor: 100, vencimento: "2026-10-19", dias_restantes: 2, data_alerta: "2026-10-17", responsavel_email: "x@y", ...o });

describe("alertasParcela", () => {
  it("normaliza entrada invalida para lista vazia e descarta linhas sem aluno/parcela", () => {
    expect(normalizarAlertas(null)).toEqual([]);
    expect(normalizarAlertas([A(), { aluno_id: "x" }, null])).toHaveLength(1);
  });
  it("rotulo de dias restantes", () => {
    expect(rotuloDiasRestantes(0)).toBe("vence hoje");
    expect(rotuloDiasRestantes(1)).toBe("vence amanhã");
    expect(rotuloDiasRestantes(2)).toBe("vence em 2 dias");
    expect(rotuloDiasRestantes(-1)).toBe("vencida");
    expect(rotuloDiasRestantes("x")).toBe("");
  });
  it("formata data e valor", () => {
    expect(formatarDataBR("2026-10-19")).toBe("19/10/2026");
    expect(formatarDataBR("2026-10-19T00:00:00Z")).toBe("19/10/2026");
    expect(formatarValorBRL(665.98).replace(/\s/g, " ")).toMatch(/665,98/);
  });
  it("ordena do mais urgente ao menos, sem mutar a entrada", () => {
    const e = [A({ parcela_id: "p2", dias_restantes: 2, aluno_nome: "B" }), A({ parcela_id: "p3", dias_restantes: 0, aluno_nome: "Z" }), A({ parcela_id: "p4", dias_restantes: 2, aluno_nome: "A" })];
    const copia = JSON.stringify(e);
    expect(ordenarAlertas(e).map((x) => x.parcela_id)).toEqual(["p3", "p4", "p2"]);
    expect(JSON.stringify(e)).toBe(copia);
  });
  it("dois acordos do mesmo aluno => duas chaves distintas e duas linhas; descricao mostra acordo e parcela", () => {
    const l = [A({ acordo_id: "c1", parcela_id: "p1" }), A({ acordo_id: "c2", parcela_id: "p9", numero_acordo: 11 })];
    expect(new Set(l.map(chaveAlerta)).size).toBe(2);
    expect(alertasDoAluno(l, "a1")).toHaveLength(2);
    expect(alertasDoAluno(l, "outro")).toHaveLength(0);
    expect(descricaoAlerta(l[1])).toBe("Acordo #11 · parcela 2");
  });
});

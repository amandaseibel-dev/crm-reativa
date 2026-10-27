// Ordem e rotulo das mensalidades no detalhamento da Minha Carteira.
// A parte visual (clique, expansao, colunas) esta em
// src/components/MensalidadesDoAluno.test.jsx.
import { describe, it, expect } from "vitest";
import { ordenarMensalidades, situacaoMensalidade } from "./mensalidadesCarteira";

const M = (o) => ({ documento: "1001", competencia: "05/2026", vencimento: "2026-05-10", valor: 180.5, vencida: true, ...o });

describe("ordenarMensalidades", () => {
  it("vencimento mais antigo primeiro; sem vencimento vai para o fim", () => {
    const fora = ordenarMensalidades([
      M({ documento: "b", vencimento: null }),
      M({ documento: "c", vencimento: "2026-07-10" }),
      M({ documento: "a", vencimento: "2026-03-10" }),
    ]);
    expect(fora.map((m) => m.documento)).toEqual(["a", "c", "b"]);
  });

  it("empate de vencimento resolve pelo titulo (ordem estavel entre aberturas)", () => {
    const fora = ordenarMensalidades([
      M({ documento: "1002", vencimento: "2026-03-10" }),
      M({ documento: "1001", vencimento: "2026-03-10" }),
    ]);
    expect(fora.map((m) => m.documento)).toEqual(["1001", "1002"]);
  });

  it("aceita vencimento com hora (timestamp) sem trocar a ordem", () => {
    const fora = ordenarMensalidades([
      M({ documento: "b", vencimento: "2026-05-10T03:00:00Z" }),
      M({ documento: "a", vencimento: "2026-04-10" }),
    ]);
    expect(fora.map((m) => m.documento)).toEqual(["a", "b"]);
  });

  it("nao muta a lista recebida", () => {
    const original = [M({ documento: "z", vencimento: "2026-09-01" }), M({ documento: "a", vencimento: "2026-01-01" })];
    ordenarMensalidades(original);
    expect(original.map((m) => m.documento)).toEqual(["z", "a"]);
  });

  it("aceita lista ausente", () => {
    expect(ordenarMensalidades(undefined)).toEqual([]);
  });
});

describe("situacaoMensalidade", () => {
  it("so distingue vencida de a vencer -- e so pelo sinal que recebe", () => {
    expect(situacaoMensalidade({ vencida: true }).texto).toBe("Vencida");
    expect(situacaoMensalidade({ vencida: false }).texto).toBe("A vencer");
    expect(situacaoMensalidade({}).texto).toBe("A vencer");
  });
});

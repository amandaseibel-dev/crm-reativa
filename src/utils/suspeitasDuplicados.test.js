import { describe, it, expect } from "vitest";
import {
  agruparSuspeitasPorReferencia,
  sugerirLinhaSuspeita,
  decisaoValida,
  rotuloStatusSuspeita,
  STATUS_SUSPEITA,
} from "./suspeitasDuplicados";

describe("agruparSuspeitasPorReferencia (indício objetivo)", () => {
  it("agrupa só quando a MESMA referência bancária aparece 2+ vezes", () => {
    const pagtos = [
      { pagamento_id: "a", numero_parcela_completo: "50607630002", valor_pago: 990.16 },
      { pagamento_id: "b", numero_parcela_completo: "50607630002", valor_pago: 24.35 },
      { pagamento_id: "c", numero_parcela_completo: "50660050001", valor_pago: 1403.44 },
    ];
    const grupos = agruparSuspeitasPorReferencia(pagtos);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].chave).toBe("50607630002");
    expect(grupos[0].linhas).toHaveLength(2);
  });

  it("NÃO agrupa por mesmo nome/valor/data quando a referência é diferente", () => {
    const pagtos = [
      { pagamento_id: "a", numero_parcela_completo: "50640120001", valor_pago: 5459.56, aluno_nome: "X", data_pagamento: "2026-07-22" },
      { pagamento_id: "b", numero_parcela_completo: "50670170001", valor_pago: 5459.56, aluno_nome: "X", data_pagamento: "2026-07-22" },
    ];
    expect(agruparSuspeitasPorReferencia(pagtos)).toHaveLength(0);
  });

  it("ignora linhas sem referência bancária e linhas já estornadas", () => {
    const pagtos = [
      { pagamento_id: "a", numero_parcela_completo: null, valor_pago: 100 },
      { pagamento_id: "b", numero_parcela_completo: null, valor_pago: 100 },
      { pagamento_id: "c", numero_parcela_completo: "50660050001", valor_pago: 1403.44 },
      { pagamento_id: "d", numero_parcela_completo: "50660050001", valor_pago: 28.57, estornado: true },
    ];
    // c/d: d está estornado -> sobra 1 linha -> não é grupo
    expect(agruparSuspeitasPorReferencia(pagtos)).toHaveLength(0);
  });
});

describe("sugerirLinhaSuspeita (apenas visual)", () => {
  it("sugere a linha de MENOR valor", () => {
    const linhas = [
      { pagamento_id: "grande", valor_pago: 990.16 },
      { pagamento_id: "pequena", valor_pago: 24.35 },
    ];
    expect(sugerirLinhaSuspeita(linhas)).toBe("pequena");
  });
  it("não sugere nada quando os valores são iguais (ex.: título 65643)", () => {
    const linhas = [
      { pagamento_id: "x", valor_pago: 576.74 },
      { pagamento_id: "y", valor_pago: 576.74 },
    ];
    expect(sugerirLinhaSuspeita(linhas)).toBeNull();
  });
  it("não sugere com menos de 2 linhas", () => {
    expect(sugerirLinhaSuspeita([{ pagamento_id: "x", valor_pago: 1 }])).toBeNull();
  });
});

describe("decisaoValida (motivo obrigatório; não confirma sozinho)", () => {
  it("exige motivo", () => {
    expect(decisaoValida({ decisao: STATUS_SUSPEITA.LEGITIMO, motivo: "" })).toBe(false);
    expect(decisaoValida({ decisao: STATUS_SUSPEITA.LEGITIMO, motivo: "ok" })).toBe(true);
  });
  it("duplicidade exige manter e duplicada distintas", () => {
    expect(decisaoValida({ decisao: STATUS_SUSPEITA.DUPLICIDADE, motivo: "m" })).toBe(false);
    expect(decisaoValida({ decisao: STATUS_SUSPEITA.DUPLICIDADE, motivo: "m", pagamentoManterId: "a", pagamentoDuplicadoId: "a" })).toBe(false);
    expect(decisaoValida({ decisao: STATUS_SUSPEITA.DUPLICIDADE, motivo: "m", pagamentoManterId: "a", pagamentoDuplicadoId: "b" })).toBe(true);
  });
  it("rejeita decisão fora do conjunto permitido", () => {
    expect(decisaoValida({ decisao: "ESTORNAR", motivo: "m" })).toBe(false);
  });
});

describe("rotuloStatusSuspeita", () => {
  it("traduz os status", () => {
    expect(rotuloStatusSuspeita(STATUS_SUSPEITA.PENDENTE)).toBe("Pendente de validação");
    expect(rotuloStatusSuspeita(STATUS_SUSPEITA.LEGITIMO)).toBe("Pagamento legítimo");
    expect(rotuloStatusSuspeita(STATUS_SUSPEITA.DUPLICIDADE)).toBe("Duplicidade confirmada");
  });
});

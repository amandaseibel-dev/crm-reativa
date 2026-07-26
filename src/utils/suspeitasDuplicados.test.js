import { describe, it, expect } from "vitest";
import {
  agruparSuspeitasPorReferencia,
  sugerirLinhaSuspeita,
  decisaoValida,
  rotuloStatusSuspeita,
  STATUS_SUSPEITA,
  ACAO_DETECCAO,
  deveAvaliarDeteccao,
  avaliarDeteccaoSuspeita,
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

describe("regra permanente de detecção (espelha o trigger)", () => {
  const novo = { numero_parcela_completo: "50607630002", valor_pago: 24.35, retroativo: false };

  it("1) segunda linha da mesma referência cria suspeita", () => {
    expect(deveAvaliarDeteccao(novo, true)).toBe(true);
    const r = avaliarDeteccaoSuspeita(null, { qtdObjetivaComChave: 2, novoPagamentoId: "b" });
    expect(r.acao).toBe(ACAO_DETECCAO.CRIAR);
    expect(r.status).toBe(STATUS_SUSPEITA.PENDENTE);
  });

  it("2) reimportação da mesma linha não cria grupo (não é inserção nova)", () => {
    // ON CONFLICT DO UPDATE no importador -> não é AFTER INSERT.
    expect(deveAvaliarDeteccao(novo, false)).toBe(false);
  });

  it("3) referência diferente não cria suspeita", () => {
    // Cada referência tem só 1 ocorrência -> qtdObjetivaComChave = 1.
    const r = avaliarDeteccaoSuspeita(null, { qtdObjetivaComChave: 1, novoPagamentoId: "b" });
    expect(r.acao).toBe(ACAO_DETECCAO.IGNORAR);
  });

  it("4) grupo LEGITIMO não reabre sem pagamento novo (linha já analisada)", () => {
    const grupo = { status: STATUS_SUSPEITA.LEGITIMO, pagamentos_analisados: ["a", "b"] };
    const r = avaliarDeteccaoSuspeita(grupo, { qtdObjetivaComChave: 2, novoPagamentoId: "b" });
    expect(r.acao).toBe(ACAO_DETECCAO.ANEXAR);
    expect(r.status).toBe(STATUS_SUSPEITA.LEGITIMO);
  });

  it("5) terceiro pagamento novo reabre a análise", () => {
    const grupoLeg = { status: STATUS_SUSPEITA.LEGITIMO, pagamentos_analisados: ["a", "b"] };
    const r1 = avaliarDeteccaoSuspeita(grupoLeg, { qtdObjetivaComChave: 3, novoPagamentoId: "c" });
    expect(r1.acao).toBe(ACAO_DETECCAO.REABRIR);
    expect(r1.status).toBe(STATUS_SUSPEITA.PENDENTE);

    const grupoDup = { status: STATUS_SUSPEITA.DUPLICIDADE, pagamentos_analisados: ["a", "b"] };
    const r2 = avaliarDeteccaoSuspeita(grupoDup, { qtdObjetivaComChave: 3, novoPagamentoId: "c" });
    expect(r2.acao).toBe(ACAO_DETECCAO.REABRIR);
  });

  it("6) a detecção não devolve nenhuma mutação de pagamento (só ação de grupo)", () => {
    const r = avaliarDeteccaoSuspeita(null, { qtdObjetivaComChave: 2, novoPagamentoId: "b" });
    expect(Object.keys(r).sort()).toEqual(["acao", "status"]);
    // não há campos de estorno/valor/pagamento no retorno
    expect(r).not.toHaveProperty("valor_pago");
    expect(r).not.toHaveProperty("estornar");
  });

  it("ignora inserções não-objetivas (sem referência, retroativo, valor<=0, estornado)", () => {
    expect(deveAvaliarDeteccao({ numero_parcela_completo: null, valor_pago: 10 }, true)).toBe(false);
    expect(deveAvaliarDeteccao({ numero_parcela_completo: "x", valor_pago: 0 }, true)).toBe(false);
    expect(deveAvaliarDeteccao({ numero_parcela_completo: "x", valor_pago: 10, retroativo: true }, true)).toBe(false);
    expect(deveAvaliarDeteccao({ numero_parcela_completo: "x", valor_pago: 10, estornado: true }, true)).toBe(false);
  });
});

describe("rotuloStatusSuspeita", () => {
  it("traduz os status", () => {
    expect(rotuloStatusSuspeita(STATUS_SUSPEITA.PENDENTE)).toBe("Pendente de validação");
    expect(rotuloStatusSuspeita(STATUS_SUSPEITA.LEGITIMO)).toBe("Pagamento legítimo");
    expect(rotuloStatusSuspeita(STATUS_SUSPEITA.DUPLICIDADE)).toBe("Duplicidade confirmada");
  });
});

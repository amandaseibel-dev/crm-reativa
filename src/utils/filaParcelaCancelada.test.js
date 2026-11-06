import { describe, expect, it } from "vitest";
import {
  selarCancelamento, cobrancaPotencialmenteIndevida, filtrarFila, totaisDaFila,
  textoDoSelo, CLASSIFICACOES,
} from "./filaParcelaCancelada";

// Linhas espelhadas dos tres casos reais investigados em 19/10/2026 (medidos em
// producao, so leitura). Os valores sao os de producao de proposito: um teste com
// numero inventado nao pegaria a inversao de sinal que o caso 71006 tem.
const C71006_07_10 = {
  escopo: "PARCELA_CANCELADA", grupo: "T2", classificacao: "COMPROVADO",
  aluno_id: "a-211004249", aluno_nome: "ALUNO 211004249", matricula_prime: "211004249",
  pagamento_id: "p-71006-0710", data_pagamento: "2026-10-07", valor_pago: 781.38,
  boleto_pago: "50710060002", parcela_valor: 781.38, parcela_status: "CANCELADA",
  acordo_numero_ulbra: "71006", acordo_status: "CANCELADO",
  pagou_antes_de_cancelar: false, tem_baixa_equivalente: false, baixa_sem_vinculo: false,
  saldo_acordo_aberto: 781.38, substituto_na_janela: 1, copia_ativa_mesmo_numero: 0,
  parcelas_abertas_mesmo_valor: 1, identidade_comprovada: true,
};
const C71006_08_09 = {
  ...C71006_07_10, classificacao: "SO_VINCULO_BAIXA",
  pagamento_id: "p-71006-0809", data_pagamento: "2026-09-08", boleto_pago: "50710060001",
  pagou_antes_de_cancelar: true, tem_baixa_equivalente: true, baixa_sem_vinculo: true,
};
const C52411_28_09 = {
  escopo: "PARCELA_CANCELADA", grupo: "T1", classificacao: "SO_VINCULO_BAIXA",
  aluno_id: "a-71014381", aluno_nome: "ALUNO 71014381", matricula_prime: "71014381",
  pagamento_id: "p-52411-2809", data_pagamento: "2026-09-28", valor_pago: 333.11,
  boleto_pago: "50524110007", parcela_valor: 320.89, parcela_status: "CANCELADA",
  acordo_numero_ulbra: "52411", acordo_status: "CANCELADO",
  pagou_antes_de_cancelar: true, tem_baixa_equivalente: false, baixa_sem_vinculo: false,
  saldo_acordo_aberto: 0, substituto_na_janela: 0, copia_ativa_mesmo_numero: 0,
  parcelas_abertas_mesmo_valor: 0, identidade_comprovada: true,
};
const C52411_20_07 = {
  ...C52411_28_09, pagamento_id: "p-52411-2007", data_pagamento: "2026-07-20",
  valor_pago: 328.88, boleto_pago: "50524110006", parcela_valor: 328.88,
};
const C71398 = {
  escopo: "PARCELA_CANCELADA", grupo: "T1", classificacao: "SO_VINCULO_BAIXA",
  aluno_id: "a-2024009347", aluno_nome: "ALUNO 2024009347", matricula_prime: "2024009347",
  pagamento_id: "p-71398", data_pagamento: "2026-09-09", valor_pago: 42373.80,
  boleto_pago: "50713980001", parcela_valor: 42373.80, parcela_status: "CANCELADA",
  acordo_numero_ulbra: "71398", acordo_status: "CANCELADO",
  pagou_antes_de_cancelar: true, tem_baixa_equivalente: false, baixa_sem_vinculo: false,
  saldo_acordo_aberto: 0, substituto_na_janela: 0, copia_ativa_mesmo_numero: 0,
  parcelas_abertas_mesmo_valor: 0, identidade_comprovada: true,
};
const C64194 = {
  escopo: "PARCELA_CANCELADA", grupo: "T2", classificacao: "SINAL_FORTE",
  aluno_id: "a-232000377", aluno_nome: "ALUNO 232000377", matricula_prime: "232000377",
  pagamento_id: "p-64194", data_pagamento: "2026-07-14", valor_pago: 6761.27,
  boleto_pago: "50641940002", parcela_valor: 6761.27, parcela_status: "CANCELADA",
  acordo_numero_ulbra: "64194", acordo_status: "CANCELADO",
  pagou_antes_de_cancelar: true, tem_baixa_equivalente: false, baixa_sem_vinculo: false,
  saldo_acordo_aberto: 33806.40, substituto_na_janela: 0, copia_ativa_mesmo_numero: 1,
  parcelas_abertas_mesmo_valor: 5, identidade_comprovada: true,
};
const SEM_MATRICULA = {
  ...C64194, pagamento_id: "p-sem-mat", aluno_id: "a-sem-mat", matricula_prime: null,
  classificacao: "INVESTIGAR", valor_pago: 619.65, parcela_valor: 283.30,
  parcelas_abertas_mesmo_valor: 0, copia_ativa_mesmo_numero: 0, saldo_acordo_aberto: 566.60,
  identidade_comprovada: false,
};
const PARCELA_ABERTA = {
  ...C64194, escopo: "ACORDO_CANCELADO_PARCELA_ABERTA", pagamento_id: "p-aberta",
  aluno_id: "a-aberta", parcela_status: "VENCIDA", valor_pago: 1416.11,
  classificacao: "INVESTIGAR", parcelas_abertas_mesmo_valor: 0, copia_ativa_mesmo_numero: 0,
};

const FILA = [C71006_07_10, C64194, SEM_MATRICULA, C71006_08_09, C52411_28_09,
              C52411_20_07, C71398, PARCELA_ABERTA];

describe("selo de cancelamento: a guarda que a #692 não tem", () => {
  it("INVARIANTE: cancelamento nunca sai apresentável como candidato", () => {
    const statusParcela = ["CANCELADA", "PAGO", "VENCIDA", "A_VENCER", null, "", "cancelada"];
    const statusAcordo = ["CANCELADO", "ATIVO", "QUITADO", null, "", "cancelado"];
    for (const p of statusParcela) {
      for (const a of statusAcordo) {
        const r = selarCancelamento({ situacao: "CANDIDATO_DETERMINISTICO" },
          { status_parcela: p, status_acordo: a });
        const haCancelamento = String(p ?? "").toUpperCase() === "CANCELADA"
          || String(a ?? "").toUpperCase() === "CANCELADO";
        const estadoIncompleto = !p || !a;
        if (haCancelamento) {
          expect(r.cancelado, `${p}/${a}`).toBe(true);
          expect(r.apresentavel_como_candidato, `${p}/${a}`).toBe(false);
          expect(r.selos.length, `${p}/${a}`).toBeGreaterThan(0);
        }
        if (estadoIncompleto) {
          expect(r.apresentavel_como_candidato, `${p}/${a}`).toBe(false);
          expect(r.selos, `${p}/${a}`).toContain("ESTADO_NAO_CONFERIDO");
        }
        // nunca promove: so vira candidato quando tudo foi conferido e nada esta cancelado
        if (r.apresentavel_como_candidato) {
          expect(haCancelamento).toBe(false);
          expect(estadoIncompleto).toBe(false);
        }
      }
    }
  });

  it("estado desconhecido bloqueia em vez de assumir que está tudo bem", () => {
    const r = selarCancelamento({ situacao: "CANDIDATO_DETERMINISTICO" }, {});
    expect(r.apresentavel_como_candidato).toBe(false);
    expect(r.selos).toContain("ESTADO_NAO_CONFERIDO");
    expect(r.cancelado).toBe(false); // nao afirma cancelamento que nao conferiu
  });

  it("parcela sadia e acordo ativo seguem apresentáveis", () => {
    const r = selarCancelamento({ situacao: "CANDIDATO_DETERMINISTICO" },
      { status_parcela: "VENCIDA", status_acordo: "ATIVO" });
    expect(r.apresentavel_como_candidato).toBe(true);
    expect(r.selos).toEqual([]);
  });

  it("não inventa candidato a partir de resultado que não era candidato", () => {
    const r = selarCancelamento({ situacao: "REVISAO", motivo: "ACORDO_NAO_ENCONTRADO" },
      { status_parcela: "VENCIDA", status_acordo: "ATIVO" });
    expect(r.apresentavel_como_candidato).toBe(false);
    expect(r.motivo).toBe("ACORDO_NAO_ENCONTRADO");
  });

  it("preserva o resultado original e aceita entrada inválida sem quebrar", () => {
    expect(selarCancelamento(null, { status_parcela: "CANCELADA", status_acordo: "CANCELADO" }))
      .toMatchObject({ cancelado: true, apresentavel_como_candidato: false });
    expect(selarCancelamento({ situacao: "CANDIDATOS_IDENTIFICADOS", confirmacao_id: "c1" },
      { status_parcela: "CANCELADA", status_acordo: "CANCELADO" }).confirmacao_id).toBe("c1");
  });

  it("todo selo tem texto na tela", () => {
    for (const s of ["PARCELA_CANCELADA", "ACORDO_CANCELADO", "ESTADO_NAO_CONFERIDO"]) {
      expect(textoDoSelo(s).length).toBeGreaterThan(0);
    }
  });
});

describe("cobrança potencialmente indevida", () => {
  it("71006 de 07/10 é o caso comprovado: sem baixa, saldo aberto e valor exato", () => {
    expect(cobrancaPotencialmenteIndevida(C71006_07_10)).toBe(true);
  });

  it("o mesmo acordo em 08/09 NÃO entra: já tem baixa equivalente", () => {
    expect(cobrancaPotencialmenteIndevida(C71006_08_09)).toBe(false);
  });

  it("52411 e 71398 não entram: o aluno não tem saldo de acordo aberto", () => {
    expect(cobrancaPotencialmenteIndevida(C52411_28_09)).toBe(false);
    expect(cobrancaPotencialmenteIndevida(C52411_20_07)).toBe(false);
    expect(cobrancaPotencialmenteIndevida(C71398)).toBe(false);
  });

  it("64194 entra por casamento de valor, mesmo sem substituto na janela", () => {
    expect(cobrancaPotencialmenteIndevida(C64194)).toBe(true);
  });

  it("saldo aberto sem casamento de valor é exposição, não cobrança indevida", () => {
    expect(cobrancaPotencialmenteIndevida(SEM_MATRICULA)).toBe(false);
    expect(cobrancaPotencialmenteIndevida({ ...C64194, parcelas_abertas_mesmo_valor: 0 })).toBe(false);
  });

  it("entrada ausente não vira verdadeiro", () => {
    expect(cobrancaPotencialmenteIndevida(null)).toBe(false);
    expect(cobrancaPotencialmenteIndevida({})).toBe(false);
  });
});

describe("filtros da fila", () => {
  it("o escopo padrão é parcela cancelada e exclui a parcela aberta", () => {
    const r = filtrarFila(FILA);
    expect(r).toHaveLength(7);
    expect(r.some((l) => l.escopo === "ACORDO_CANCELADO_PARCELA_ABERTA")).toBe(false);
  });

  it("TODOS mostra os dois escopos", () => {
    expect(filtrarFila(FILA, { escopo: "TODOS" })).toHaveLength(8);
  });

  it("filtra por risco", () => {
    expect(filtrarFila(FILA, { classificacao: "COMPROVADO" }).map((l) => l.pagamento_id))
      .toEqual(["p-71006-0710"]);
    expect(filtrarFila(FILA, { classificacao: "SO_VINCULO_BAIXA" })).toHaveLength(4);
  });

  it("filtra por ausência de baixa", () => {
    const r = filtrarFila(FILA, { somenteSemBaixa: true });
    expect(r.every((l) => !l.tem_baixa_equivalente)).toBe(true);
    expect(r.map((l) => l.pagamento_id)).not.toContain("p-71006-0809");
  });

  it("filtra por acordo ativo duplicado pelo mesmo número", () => {
    expect(filtrarFila(FILA, { somenteComCopiaAtiva: true }).map((l) => l.pagamento_id))
      .toEqual(["p-64194"]);
  });

  it("filtra por cobrança potencialmente indevida", () => {
    expect(filtrarFila(FILA, { somenteCobrancaPotencial: true }).map((l) => l.pagamento_id).sort())
      .toEqual(["p-64194", "p-71006-0710"]);
  });

  it("filtros se combinam e nunca inventam linha", () => {
    expect(filtrarFila(FILA, { classificacao: "COMPROVADO", somenteSemBaixa: true })).toHaveLength(1);
    expect(filtrarFila(FILA, { classificacao: "COMPROVADO", somenteComCopiaAtiva: true })).toHaveLength(0);
    expect(filtrarFila(null)).toEqual([]);
  });
});

describe("totais da fila", () => {
  it("soma só o que está na lista recebida", () => {
    const t = totaisDaFila(filtrarFila(FILA));
    expect(t.pagamentos).toBe(7);
    expect(t.alunos).toBe(5);
    // 781.38 + 6761.27 + 619.65 + 781.38 + 333.11 + 328.88 + 42373.80
    expect(t.valor).toBeCloseTo(51979.47, 2);
    // tira o 08/09, que tem baixa
    expect(t.valor_sem_baixa).toBeCloseTo(51198.09, 2);
    expect(t.cobranca_potencial).toBe(2);
    expect(t.sem_identidade).toBe(1);
  });

  it("conta por classificação e cobre as quatro", () => {
    const t = totaisDaFila(filtrarFila(FILA));
    expect(Object.keys(t.por_classificacao).sort()).toEqual([...CLASSIFICACOES].sort());
    expect(t.por_classificacao.COMPROVADO).toBe(1);
    expect(t.por_classificacao.SINAL_FORTE).toBe(1);
    expect(t.por_classificacao.INVESTIGAR).toBe(1);
    expect(t.por_classificacao.SO_VINCULO_BAIXA).toBe(4);
  });

  it("soma em centavos, sem erro de ponto flutuante", () => {
    const t = totaisDaFila([{ valor_pago: 0.1, aluno_id: "x" }, { valor_pago: 0.2, aluno_id: "x" }]);
    expect(t.valor).toBe(0.3);
    expect(t.alunos).toBe(1);
  });

  it("lista vazia não quebra", () => {
    expect(totaisDaFila([])).toMatchObject({ pagamentos: 0, alunos: 0, valor: 0 });
    expect(totaisDaFila(null).pagamentos).toBe(0);
  });
});

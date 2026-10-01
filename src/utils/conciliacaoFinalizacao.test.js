// A REGRA DE FINALIZACAO DA FILA, NO FRONT.
//
// `finalizacaoInvalida` existe para a tela nunca oferecer um botao que o banco
// vai recusar. Os catalogos aqui e o CHECK da migration 20260923020000 sao a
// mesma lista -- este teste trava os dois juntos.
import { describe, it, expect } from "vitest";
import {
  CONCLUSOES_FEITO, MOTIVOS_REJEICAO, finalizacaoInvalida,
} from "./conciliacaoPagamento";

// Espelho do catalogo da migration. Se alguem mexer num lado so, quebra aqui
// antes de quebrar em producao.
const NO_BANCO = {
  FEITO: ["ENTRADA_DE_ACORDO", "PARCELA_DE_ACORDO", "JA_TRATADO",
          "SEM_IMPACTO_FINANCEIRO", "OUTRO_CONFIRMADO"],
  REJEITAR: ["NAO_E_ENTRADA_DE_ACORDO", "NAO_PERTENCE_AO_ACORDO",
             "SEM_ESTRUTURA_SUFICIENTE", "DOCUMENTO_INCOMPATIVEL",
             "VALOR_INCOMPATIVEL", "OUTRO"],
};

describe("catalogo da tela x catalogo do banco", () => {
  it("FEITO oferece exatamente o que o banco aceita", () => {
    expect(CONCLUSOES_FEITO.map((o) => o.valor)).toEqual(NO_BANCO.FEITO);
  });
  it("REJEITAR oferece exatamente o que o banco aceita", () => {
    expect(MOTIVOS_REJEICAO.map((o) => o.valor)).toEqual(NO_BANCO.REJEITAR);
  });
  it("toda opcao tem rotulo legivel", () => {
    for (const o of [...CONCLUSOES_FEITO, ...MOTIVOS_REJEICAO]) {
      expect(o.rotulo.trim().length).toBeGreaterThan(3);
      expect(o.rotulo).not.toMatch(/_/);
    }
  });
});

describe("finalizacaoInvalida", () => {
  it("exige escolha nas duas acoes", () => {
    expect(finalizacaoInvalida({ acao: "FEITO", escolha: "", observacao: "x" })).toMatch(/conclus/i);
    expect(finalizacaoInvalida({ acao: "REJEITAR", escolha: "", observacao: "x" })).toMatch(/motivo/i);
  });

  it("libera as escolhas normais sem observacao", () => {
    expect(finalizacaoInvalida({ acao: "FEITO", escolha: "JA_TRATADO", observacao: "" })).toBeNull();
    expect(finalizacaoInvalida({ acao: "REJEITAR", escolha: "VALOR_INCOMPATIVEL", observacao: "" })).toBeNull();
  });

  it('"outro" dos dois lados exige observacao', () => {
    expect(finalizacaoInvalida({ acao: "FEITO", escolha: "OUTRO_CONFIRMADO", observacao: "" })).toMatch(/exige observ/i);
    expect(finalizacaoInvalida({ acao: "REJEITAR", escolha: "OUTRO", observacao: "  " })).toMatch(/exige observ/i);
    expect(finalizacaoInvalida({ acao: "REJEITAR", escolha: "OUTRO", observacao: "porque sim" })).toBeNull();
  });

  it("observacao so de espaco nao conta como preenchida", () => {
    expect(finalizacaoInvalida({ acao: "FEITO", escolha: "OUTRO_CONFIRMADO", observacao: "\t \n" })).not.toBeNull();
  });
});

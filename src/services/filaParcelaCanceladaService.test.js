import { describe, expect, it } from "vitest";
import { lerFilaParcelaCancelada } from "./filaParcelaCanceladaService";

const LINHA_71006 = {
  escopo: "PARCELA_CANCELADA", grupo: "T2", classificacao: "COMPROVADO",
  pagamento_id: "p-71006-0710", valor_pago: 781.38, boleto_pago: "50710060002",
  parcela_status: "CANCELADA", acordo_status: "CANCELADO", acordo_numero_ulbra: "71006",
  tem_baixa_equivalente: false, saldo_acordo_aberto: 781.38,
  substituto_na_janela: 1, parcelas_abertas_mesmo_valor: 1, identidade_comprovada: true,
};

function cliente({ data = [LINHA_71006], error = null, espiao = [] } = {}) {
  return {
    rpc: (fn) => { espiao.push(fn); return Promise.resolve({ data, error }); },
    espiao,
  };
}

describe("leitura da fila de parcela cancelada", () => {
  it("chama a RPC da fila e nada mais", async () => {
    const espiao = [];
    await lerFilaParcelaCancelada(cliente({ espiao }));
    expect(espiao).toEqual(["fila_pagamento_parcela_cancelada"]);
  });

  it("sela cada linha, então nenhuma sai apresentável como candidato", async () => {
    const { linhas, erro } = await lerFilaParcelaCancelada(cliente());
    expect(erro).toBeNull();
    expect(linhas).toHaveLength(1);
    expect(linhas[0].cancelado).toBe(true);
    expect(linhas[0].apresentavel_como_candidato).toBe(false);
    expect(linhas[0].selos).toEqual(["PARCELA_CANCELADA", "ACORDO_CANCELADO"]);
    // e preserva o que veio do banco
    expect(linhas[0].classificacao).toBe("COMPROVADO");
    expect(linhas[0].valor_pago).toBe(781.38);
  });

  it("42501 do portão vira SEM_PERMISSAO_DE_GESTAO, não erro genérico", async () => {
    const porCodigo = await lerFilaParcelaCancelada(cliente({ data: null, error: { code: "42501" } }));
    expect(porCodigo).toEqual({ linhas: [], erro: "SEM_PERMISSAO_DE_GESTAO" });
    const porMensagem = await lerFilaParcelaCancelada(
      cliente({ data: null, error: new Error("42501: somente a gestao pode consultar") }));
    expect(porMensagem.erro).toBe("SEM_PERMISSAO_DE_GESTAO");
  });

  it("falha fechada: erro não devolve lista pela metade", async () => {
    const r = await lerFilaParcelaCancelada(cliente({ data: [LINHA_71006], error: new Error("timeout") }));
    expect(r).toEqual({ linhas: [], erro: "LEITURA_NEGADA_OU_INCOMPLETA" });
  });

  it("retorno que não é lista é tratado como falha, não como fila vazia", async () => {
    expect((await lerFilaParcelaCancelada(cliente({ data: null }))).erro)
      .toBe("LEITURA_NEGADA_OU_INCOMPLETA");
    expect((await lerFilaParcelaCancelada(cliente({ data: { linhas: [] } }))).erro)
      .toBe("LEITURA_NEGADA_OU_INCOMPLETA");
  });

  it("fila realmente vazia é sucesso com zero linhas", async () => {
    expect(await lerFilaParcelaCancelada(cliente({ data: [] }))).toEqual({ linhas: [], erro: null });
  });

  it("sem cliente não tenta ler", async () => {
    expect(await lerFilaParcelaCancelada(null)).toEqual({ linhas: [], erro: "PARAMETROS_INVALIDOS" });
  });

  it("não escreve: o cliente falso só expõe rpc, e um insert quebraria o teste", async () => {
    const c = cliente();
    expect(c.from).toBeUndefined();
    const { erro } = await lerFilaParcelaCancelada(c);
    expect(erro).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { mensagemCancelamento, rotuloDesfecho, tomDoDesfecho, DESFECHOS } from "./desfechoCancelamento";

describe("mensagem do desfecho do cancelamento", () => {
  it("CANCELAMENTO_EFETIVO com mensalidade devolvida diz que voltou para em aberto", () => {
    const m = mensagemCancelamento({
      desfecho: "CANCELAMENTO_EFETIVO", mensalidades_devolvidas: 2,
      vinculos_desativados: 2, vinculos_total: 2, titulos_conferir: 0,
    });
    expect(m).toMatch(/2 mensalidades voltaram/);
    expect(m).toMatch(/nova negociação/);
  });

  it("CANCELAMENTO_EFETIVO sem devolver explica o saldo residual, nao cala", () => {
    const m = mensagemCancelamento({
      desfecho: "CANCELAMENTO_EFETIVO", mensalidades_devolvidas: 0,
      vinculos_desativados: 1, vinculos_total: 1, titulos_conferir: 0,
    });
    expect(m).toMatch(/1 vínculo desfeito/);
    expect(m).toMatch(/Nenhuma mensalidade voltou/);
    expect(m).toMatch(/saldo residual/);
  });

  it("COMPOSICAO_AUSENTE sem vinculo nenhum NAO afirma sucesso operacional", () => {
    const m = mensagemCancelamento({
      desfecho: "COMPOSICAO_AUSENTE", mensalidades_devolvidas: 0,
      vinculos_desativados: 0, vinculos_total: 0, titulos_conferir: 0,
    });
    expect(m).toMatch(/NENHUMA mensalidade foi devolvida/);
    expect(m).toMatch(/não tinha composição/);
    expect(m).toMatch(/Prime/);
    // o texto antigo, que era o defeito, nao pode sobrar
    expect(m).not.toBe("Acordo cancelado.");
  });

  it("COMPOSICAO_AUSENTE com vinculo que ja estava solto diz isso", () => {
    const m = mensagemCancelamento({
      desfecho: "COMPOSICAO_AUSENTE", mensalidades_devolvidas: 0,
      vinculos_desativados: 0, vinculos_total: 3, titulos_conferir: 0,
    });
    expect(m).toMatch(/3 vínculos dele já estavam desfeitos/);
    expect(m).not.toMatch(/não tinha composição/);
  });

  it("CONFERENCIA_NECESSARIA avisa que nada foi reaberto e pede a gestao", () => {
    const m = mensagemCancelamento({
      desfecho: "CONFERENCIA_NECESSARIA", mensalidades_devolvidas: 0,
      vinculos_desativados: 1, vinculos_total: 1, titulos_conferir: 1,
    });
    expect(m).toMatch(/1 mensalidade continua/);
    expect(m).toMatch(/QUITADA/);
    expect(m).toMatch(/Nada foi reaberto e nenhum pagamento foi desfeito/);
    expect(m).toMatch(/gestão financeira/);
  });

  it("plural correto na conferencia", () => {
    const m = mensagemCancelamento({ desfecho: "CONFERENCIA_NECESSARIA", titulos_conferir: 3 });
    expect(m).toMatch(/3 mensalidades continuam/);
    expect(m).toMatch(/QUITADAS/);
  });

  // COMPATIBILIDADE: a migration da E5 nao esta aplicada em producao. Enquanto
  // nao estiver, o retorno nao traz `desfecho` e a tela nao pode quebrar nem
  // inventar desfecho.
  it("retorno antigo (sem desfecho) cai no texto de sempre", () => {
    expect(mensagemCancelamento({ ok: true, vinculos_desativados: 0, parcelas_canceladas: 1 }))
      .toBe("Acordo cancelado.");
  });

  it("retorno nulo ou nao-objeto nao quebra", () => {
    expect(mensagemCancelamento(null)).toBe("Acordo cancelado.");
    expect(mensagemCancelamento(undefined)).toBe("Acordo cancelado.");
    expect(mensagemCancelamento("ok")).toBe("Acordo cancelado.");
  });

  it("desfecho desconhecido cai no texto de sempre em vez de mentir", () => {
    expect(mensagemCancelamento({ desfecho: "ALGO_NOVO" })).toBe("Acordo cancelado.");
  });

  it("rotulo e tom dos tres desfechos", () => {
    expect(Object.keys(DESFECHOS)).toEqual([
      "CANCELAMENTO_EFETIVO", "COMPOSICAO_AUSENTE", "CONFERENCIA_NECESSARIA",
    ]);
    expect(rotuloDesfecho("CONFERENCIA_NECESSARIA")).toMatch(/conferencia/i);
    expect(tomDoDesfecho("COMPOSICAO_AUSENTE")).toBe("amarelo");
    expect(tomDoDesfecho("CANCELAMENTO_EFETIVO")).toBe("verde");
    expect(rotuloDesfecho(undefined)).toBe("Cancelado");
    expect(tomDoDesfecho("ALGO_NOVO")).toBe("cinza");
  });
});

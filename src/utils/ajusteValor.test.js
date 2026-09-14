import { describe, it, expect } from "vitest";
import {
  EMAILS_AJUSTE_VALOR, podeAjustarValor, valorBaseTitulo, valorOperacionalTitulo,
  temAjusteValor, diferencaDoAjuste, bloqueioAjusteValor,
} from "./ajusteValor";

// Titulo cobravel de verdade: aberto, sem acordo, mensalidade.
function tituloAberto(extra = {}) {
  return {
    id: "t1", situacao: "ABERTO", status: "em_aberto",
    tipo_boleto: "Cursos de Graduação Presencial", acordo_id: null,
    valor_original: 5000, valor_em_aberto: 5000, saldo_corrigido: 5000,
    valor_cobranca_ajustado: null, ...extra,
  };
}

describe("quem pode ajustar", () => {
  it("Amanda consegue ajustar", () => {
    expect(podeAjustarValor("amanda.seibel@aelbra.com.br")).toBe(true);
  });

  it("Fernanda consegue ajustar", () => {
    expect(podeAjustarValor("cobranca04@aelbra.com.br")).toBe(true);
  });

  it("operador comum nao consegue", () => {
    for (const e of ["cobranca11@aelbra.com.br", "cobranca08@aelbra.com.br",
                     "cobranca05@aelbra.com.br", "cobranca03@aelbra.com.br"]) {
      expect(podeAjustarValor(e)).toBe(false);
    }
  });

  it("a lista tem exatamente duas pessoas, e nao inclui a Amanda Borges", () => {
    // cobranca07@ e a Amanda Borges, do administrativo -- outra pessoa.
    expect(EMAILS_AJUSTE_VALOR).toEqual([
      "amanda.seibel@aelbra.com.br",
      "cobranca04@aelbra.com.br",
    ]);
    expect(podeAjustarValor("cobranca07@aelbra.com.br")).toBe(false);
  });

  it("vazio, nulo e caixa alta nao furam a lista", () => {
    expect(podeAjustarValor("")).toBe(false);
    expect(podeAjustarValor(null)).toBe(false);
    expect(podeAjustarValor(undefined)).toBe(false);
    expect(podeAjustarValor("  AMANDA.SEIBEL@AELBRA.COM.BR  ")).toBe(true);
  });
});

describe("valor operacional", () => {
  it("sem ajuste, vale a regra de sempre", () => {
    expect(valorOperacionalTitulo(tituloAberto())).toBe(5000);
    expect(valorOperacionalTitulo(tituloAberto({ saldo_corrigido: null }))).toBe(5000);
    expect(valorOperacionalTitulo(tituloAberto({ saldo_corrigido: null, valor_em_aberto: null }))).toBe(5000);
  });

  it("com ajuste, vale o ajuste", () => {
    const t = tituloAberto({ valor_cobranca_ajustado: 4200 });
    expect(valorOperacionalTitulo(t)).toBe(4200);
  });

  it("o valor original nunca muda", () => {
    const t = tituloAberto({ valor_cobranca_ajustado: 4200 });
    expect(t.valor_original).toBe(5000);
    expect(t.valor_em_aberto).toBe(5000);
    expect(t.saldo_corrigido).toBe(5000);
    expect(valorBaseTitulo(t)).toBe(5000);
  });

  it("o ajuste muda o saldo na diferenca exata", () => {
    const semAjuste = tituloAberto();
    const comAjuste = tituloAberto({ valor_cobranca_ajustado: 4200 });
    const delta = valorOperacionalTitulo(semAjuste) - valorOperacionalTitulo(comAjuste);
    expect(delta).toBe(800);
    expect(diferencaDoAjuste(comAjuste)).toBe(800);
    expect(diferencaDoAjuste(semAjuste)).toBe(0);
  });

  it("remover o ajuste restaura o valor anterior", () => {
    const antes = tituloAberto();
    const ajustado = { ...antes, valor_cobranca_ajustado: 4200 };
    const removido = { ...ajustado, valor_cobranca_ajustado: null };
    expect(valorOperacionalTitulo(antes)).toBe(5000);
    expect(valorOperacionalTitulo(ajustado)).toBe(4200);
    expect(valorOperacionalTitulo(removido)).toBe(valorOperacionalTitulo(antes));
  });

  it("zero e negativo nao contam como ajuste", () => {
    expect(temAjusteValor(tituloAberto({ valor_cobranca_ajustado: 0 }))).toBe(false);
    expect(temAjusteValor(tituloAberto({ valor_cobranca_ajustado: -1 }))).toBe(false);
    expect(valorOperacionalTitulo(tituloAberto({ valor_cobranca_ajustado: 0 }))).toBe(5000);
  });

  it("a soma da carteira anda exatamente a diferenca", () => {
    const carteira = [tituloAberto({ id: "a" }), tituloAberto({ id: "b", valor_original: 1000, valor_em_aberto: 1000, saldo_corrigido: 1000 })];
    const antes = carteira.reduce((s, t) => s + valorOperacionalTitulo(t), 0);
    const depois = carteira
      .map((t) => (t.id === "a" ? { ...t, valor_cobranca_ajustado: 4200 } : t))
      .reduce((s, t) => s + valorOperacionalTitulo(t), 0);
    expect(antes).toBe(6000);
    expect(depois).toBe(5200);
    expect(antes - depois).toBe(800);
  });
});

describe("o que nao aceita ajuste", () => {
  it("titulo cobravel aceita", () => {
    expect(bloqueioAjusteValor(tituloAberto())).toBeNull();
  });

  it("PAGO, CANCELADA, DUPLICADA, de acordo e negociado sao recusados", () => {
    const casos = [
      [{ situacao: "PAGO", status: "quitada" }, "TITULO_PAGO"],
      [{ situacao: "CANCELADA", status: "cancelada" }, "TITULO_CANCELADO"],
      [{ situacao: "DUPLICADA" }, "TITULO_DUPLICADO"],
      [{ tipo_boleto: "Acordo" }, "TITULO_DE_ACORDO"],
      [{ situacao: "NEGOCIADO", status: "vinculada" }, "TITULO_NAO_ABERTO"],
      [{ acordo_id: "acordo-1" }, "TITULO_EM_ACORDO"],
      [{ status: "vinculada" }, "TITULO_NAO_COBRAVEL"],
      [{ valor_original: 0, valor_em_aberto: 0, saldo_corrigido: 0 }, "TITULO_SEM_VALOR"],
    ];
    for (const [extra, esperado] of casos) {
      expect(bloqueioAjusteValor(tituloAberto(extra))).toBe(esperado);
    }
  });

  it("os 50 titulos historicos tipo_boleto='Acordo' nao podem receber ajuste", () => {
    // Sao os que ficaram ABERTO/em_aberto depois do cancelamento do acordo.
    const historico = tituloAberto({
      tipo_boleto: "Acordo", saldo_corrigido: null, valor_em_aberto: 3368.34, valor_original: 3368.34,
    });
    expect(bloqueioAjusteValor(historico)).toBe("TITULO_DE_ACORDO");
    // E sem ajuste possivel, o valor operacional deles continua o de hoje.
    expect(valorOperacionalTitulo(historico)).toBe(3368.34);
    expect(temAjusteValor(historico)).toBe(false);
  });
});

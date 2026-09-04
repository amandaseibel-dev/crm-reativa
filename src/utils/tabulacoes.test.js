import { describe, it, expect, vi, beforeEach } from "vitest";

// Dublê do banco: o que se prova aqui é a RÉGUA (prazo e próxima ação) que
// toda tela de tabular passa a usar, e que sem banco ela continua existindo.
const fromMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { from: (...a) => fromMock(...a) } }));

import {
  FALLBACK_TABULACOES,
  carregarTabulacoes,
  invalidarCacheTabulacoes,
  retornoAutomaticoDeTabulacao,
  desfechoDaTabulacao,
  descreverPrazo,
  proximaAcaoDeTabulacao,
  retornoEhManual,
  dataBRDeISO,
} from "./tabulacoes";

const CATALOGO = FALLBACK_TABULACOES;
const SEXTA = new Date(2026, 8, 4, 10, 0); // sexta-feira 04/09/2026
const TERCA = new Date(2026, 8, 8, 10, 0); // terça-feira 08/09/2026

function bancoResponde(resposta) {
  fromMock.mockReturnValue({
    select: () => ({ order: () => ({ order: async () => resposta }) }),
  });
}

beforeEach(() => {
  fromMock.mockReset();
  invalidarCacheTabulacoes();
});

describe("retorno automático pelo catálogo", () => {
  it("Mensagem enviada: 5 dias úteis caem na mesma data da semana seguinte, sempre em dia útil", () => {
    expect(retornoAutomaticoDeTabulacao(CATALOGO, "MENSAGEM_ENVIADA", SEXTA)).toBe("2026-09-11");
    expect(retornoAutomaticoDeTabulacao(CATALOGO, "MENSAGEM_ENVIADA", TERCA)).toBe("2026-09-15");
  });

  it("1 dia útil na sexta pula o fim de semana", () => {
    expect(retornoAutomaticoDeTabulacao(CATALOGO, "NAO_LOCALIZADO", SEXTA)).toBe("2026-09-07");
  });

  it("tabulação sem prazo, manual ou fora do catálogo não agenda", () => {
    expect(retornoAutomaticoDeTabulacao(CATALOGO, "CONTATAR", SEXTA)).toBeNull();
    expect(retornoAutomaticoDeTabulacao(CATALOGO, "RETORNAR_DEPOIS", SEXTA)).toBeNull();
    expect(retornoAutomaticoDeTabulacao(CATALOGO, "LEMBRETE_PARCELA", SEXTA)).toBeNull();
  });
});

describe("desfechoDaTabulacao", () => {
  it("data digitada pelo operador vale e vira compromisso (OPERADOR)", () => {
    expect(desfechoDaTabulacao(CATALOGO, "MENSAGEM_ENVIADA", { hoje: SEXTA, dataDigitada: "2026-09-20" })).toEqual({
      proxima_acao: "CONTATAR", data_retorno: "2026-09-20", retorno_origem: "OPERADOR", motivo: "DIGITADA",
    });
  });

  it("compromisso futuro do operador não é apagado pela tabulação de hoje", () => {
    const r = desfechoDaTabulacao(CATALOGO, "MENSAGEM_ENVIADA", {
      hoje: SEXTA, retornoAtual: { data: "2026-09-25", origem: "OPERADOR" },
    });
    expect(r).toMatchObject({ data_retorno: "2026-09-25", retorno_origem: "OPERADOR", motivo: "MANTIDA" });
  });

  it("data automática antiga, ou compromisso já passado, é recalculada pela régua", () => {
    const automatica = desfechoDaTabulacao(CATALOGO, "MENSAGEM_ENVIADA", {
      hoje: SEXTA, retornoAtual: { data: "2026-09-25", origem: "AUTOMATICO" },
    });
    expect(automatica).toMatchObject({ data_retorno: "2026-09-11", retorno_origem: "AUTOMATICO", motivo: "AUTOMATICA" });
    const passada = desfechoDaTabulacao(CATALOGO, "MENSAGEM_ENVIADA", {
      hoje: SEXTA, retornoAtual: { data: "2026-09-01", origem: "OPERADOR" },
    });
    expect(passada).toMatchObject({ data_retorno: "2026-09-11", motivo: "AUTOMATICA" });
  });

  it("tabulação sem prazo não toca em data_retorno", () => {
    const r = desfechoDaTabulacao(CATALOGO, "CONTATAR", { hoje: SEXTA });
    expect(r).toEqual({ proxima_acao: "CONTATAR", motivo: "NENHUMA" });
    expect("data_retorno" in r).toBe(false);
  });

  it("próxima ação vem do catálogo; fora dele é CONTATAR", () => {
    expect(proximaAcaoDeTabulacao(CATALOGO, "ACORDO_FECHADO")).toBe("ACOMPANHAR_PAGAMENTO");
    expect(proximaAcaoDeTabulacao(CATALOGO, "RETORNAR_DEPOIS")).toBe("RETORNAR");
    expect(proximaAcaoDeTabulacao(CATALOGO, "Novo caso")).toBe("CONTATAR");
    expect(retornoEhManual(CATALOGO, "RETORNAR_DEPOIS")).toBe(true);
    expect(retornoEhManual(CATALOGO, "MENSAGEM_ENVIADA")).toBe(false);
  });
});

describe("descreverPrazo", () => {
  it("explica a regra em texto", () => {
    expect(descreverPrazo(CATALOGO, "MENSAGEM_ENVIADA")).toBe("5 dias úteis");
    expect(descreverPrazo(CATALOGO, "NAO_LOCALIZADO")).toBe("1 dia útil");
    expect(descreverPrazo(CATALOGO, "RETORNAR_DEPOIS")).toBe("data escolhida pelo operador");
    expect(descreverPrazo(CATALOGO, "CONTATAR")).toBe("sem retorno automático");
    expect(dataBRDeISO("2026-09-11")).toBe("11/09/2026");
  });
});

describe("carregarTabulacoes", () => {
  it("usa o catálogo do banco quando ele responde (é ele quem manda no prazo)", async () => {
    bancoResponde({ data: [{ codigo: "MENSAGEM_ENVIADA", rotulo: "Mensagem enviada", ativa: true, ordem: 20, grupo: "CONTATO", retorno_modo: "DIAS_UTEIS", retorno_dias_uteis: 2, proxima_acao: "CONTATAR" }], error: null });
    const catalogo = await carregarTabulacoes();
    expect(retornoAutomaticoDeTabulacao(catalogo, "MENSAGEM_ENVIADA", SEXTA)).toBe("2026-09-08");
    // cache: segunda chamada não vai ao banco
    await carregarTabulacoes();
    expect(fromMock).toHaveBeenCalledTimes(1);
  });

  it("sem banco, cai no fallback em vez de deixar a tela sem régua", async () => {
    const silencio = vi.spyOn(console, "error").mockImplementation(() => {});
    bancoResponde({ data: null, error: { message: "RLS" } });
    const catalogo = await carregarTabulacoes();
    expect(catalogo).toBe(FALLBACK_TABULACOES);
    silencio.mockRestore();
  });
});

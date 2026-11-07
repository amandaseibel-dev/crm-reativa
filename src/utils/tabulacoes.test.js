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
  tabulacaoEhSoGestao,
  tabulacaoDisponivel,
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

// TABULAÇÃO SÓ DA GESTÃO -- o que estes testes protegem é o FAIL-CLOSED.
//
// A primeira versão desta frente lia `tabulacoes.somente_gestao` do catálogo
// carregado. Era fail-open: a policy `tabulacoes_leitura_autenticado`
// (20260828050000) não entrega a linha gestão-only ao operador, então o
// predicado não achava a linha, concluía "não é só-gestão" e MOSTRAVA a opção
// para quem não pode vê-la. Por isso a régua é lista literal -- e por isso o
// caso central aqui é "catálogo SEM a linha, usuário sem gestão".
describe("tabulação só da gestão", () => {
  it("Retorno do financeiro existe no catálogo e não agenda prazo", () => {
    const t = CATALOGO.find((x) => x.codigo === "RETORNO_FINANCEIRO");
    expect(t).toBeTruthy();
    expect(t.rotulo).toBe("Retorno do financeiro");
    expect(t.ativa).toBe(true);
    expect(t.grupo).toBe("FINANCEIRO");
    // Prazo NENHUM: a gestão carimba o desfecho, o caso volta pelo motor da
    // fila. Se virar DIAS_UTEIS sem decisão nova, este teste cobra.
    expect(t.retorno_modo).toBe("NENHUM");
    expect(t.retorno_dias_uteis).toBe(null);
    expect(retornoAutomaticoDeTabulacao(CATALOGO, "RETORNO_FINANCEIRO", SEXTA)).toBe(null);
    expect(descreverPrazo(CATALOGO, "RETORNO_FINANCEIRO")).toBe("sem retorno automático");
  });

  it("FAIL-CLOSED: esconde do operador mesmo que o catálogo não traga a linha", () => {
    // ESTE é o caso real do operador: a RLS filtrou a linha. A régua não pode
    // depender dela. Se alguém trocar a lista literal por leitura do catálogo,
    // este teste cai.
    expect(tabulacaoEhSoGestao("RETORNO_FINANCEIRO")).toBe(true);
    expect(tabulacaoDisponivel("RETORNO_FINANCEIRO", false)).toBe(false);
    const semALinha = CATALOGO.filter((t) => t.codigo !== "RETORNO_FINANCEIRO");
    expect(semALinha.some((t) => t.codigo === "RETORNO_FINANCEIRO")).toBe(false);
    expect(tabulacaoDisponivel("RETORNO_FINANCEIRO", false)).toBe(false);
  });

  it("a gestão vê; o operador não", () => {
    expect(tabulacaoDisponivel("RETORNO_FINANCEIRO", true)).toBe(true);
    expect(tabulacaoDisponivel("RETORNO_FINANCEIRO", false)).toBe(false);
    expect(tabulacaoDisponivel("MENSAGEM_ENVIADA", false)).toBe(true);
    expect(tabulacaoDisponivel("MENSAGEM_ENVIADA", true)).toBe(true);
  });

  it("não esconde tabulação comum, e nem código desconhecido", () => {
    // Importante não inverter o default: opção legítima que não esteja no
    // catálogo (há códigos em STATUS_FINALIZACAO sem linha na tabela) não pode
    // desaparecer da tela do operador.
    expect(tabulacaoEhSoGestao("CONTATAR")).toBe(false);
    expect(tabulacaoEhSoGestao("CODIGO_QUE_NAO_EXISTE")).toBe(false);
    expect(tabulacaoDisponivel("CODIGO_QUE_NAO_EXISTE", false)).toBe(true);
    expect(tabulacaoEhSoGestao("")).toBe(false);
    expect(tabulacaoEhSoGestao(null)).toBe(false);
  });

  it("o valor JÁ escolhido nunca desaparece do select", () => {
    // Sem isto o navegador trocaria sozinho a tabulação do aluno pela primeira
    // opção da lista -- mesma armadilha da tabulação desativada (17/08/2026).
    expect(tabulacaoDisponivel("RETORNO_FINANCEIRO", false, "RETORNO_FINANCEIRO")).toBe(true);
    expect(tabulacaoDisponivel("RETORNO_FINANCEIRO", false, "MENSAGEM_ENVIADA")).toBe(false);
  });

  // ----------------------------------------------------------------------
  // AS QUATRO DE 07/11/2026. O banco já barrava as quatro (somente_gestao e o
  // piso literal do gatilho, conferidos em produção); o que faltava era a tela
  // -- e faltava desigual, porque cada <select> tinha a sua lista à mão.
  const QUATRO = Object.freeze([
    "ALEGA_FINANCIAMENTO_CONFIRMADO", // "Financiamento confirmado pela unidade"
    "CANCELAMENTO_COBRANCA",
    "SUSPENSAO_COBRANCA",
    "JURIDICO",
  ]);

  it("as quatro de 07/11/2026 são só da gestão", () => {
    for (const codigo of QUATRO) {
      expect(tabulacaoEhSoGestao(codigo)).toBe(true);
      expect(tabulacaoDisponivel(codigo, true)).toBe(true);
      expect(tabulacaoDisponivel(codigo, false)).toBe(false);
    }
  });

  it("FAIL-CLOSED nas quatro: esconde mesmo sem a linha no catálogo", () => {
    // Mesmo caso real do operador do RETORNO_FINANCEIRO: a RLS
    // (`tabulacoes_leitura_autenticado`) filtra a linha `somente_gestao`, então
    // a régua não pode depender do catálogo. Se alguém trocar a lista literal
    // por leitura de `somente_gestao`, este teste cai.
    const semAsQuatro = CATALOGO.filter((t) => !QUATRO.includes(t.codigo));
    for (const codigo of QUATRO) {
      expect(semAsQuatro.some((t) => t.codigo === codigo)).toBe(false);
      expect(tabulacaoDisponivel(codigo, false)).toBe(false);
    }
  });

  it("o código JÁ gravado nas quatro não desaparece do select do operador", () => {
    // 182 alunos em produção carregam código só-gestão: esconder o valor atual
    // faria o navegador trocar a tabulação do aluno sozinho.
    for (const codigo of QUATRO) {
      expect(tabulacaoDisponivel(codigo, false, codigo)).toBe(true);
    }
  });

  it("a alegação ABERTA continua do operador -- só a confirmação é da gestão", () => {
    // ALEGA_FINANCIAMENTO só encaminha para a ADM apurar; quem devolve a
    // parcela é ALEGA_FINANCIAMENTO_CONFIRMADO. Restringir a confirmação não
    // pode fechar a alegação para quem atende.
    expect(tabulacaoDisponivel("ALEGA_FINANCIAMENTO", false)).toBe(true);
    expect(tabulacaoDisponivel("ALEGA_FIES", false)).toBe(true);
    expect(tabulacaoDisponivel("ALEGA_CREDIES", false)).toBe(true);
  });

  it("o front NÃO pede somente_gestao ao banco", async () => {
    // Pedir a coluna é o primeiro passo para voltar a decidir por ela. A
    // decisão versionada (20261007143000:50-54) é que o front não a lê.
    const colunasPedidas = [];
    fromMock.mockReturnValue({
      select: (colunas) => {
        colunasPedidas.push(String(colunas));
        return { order: () => ({ order: async () => ({ data: [{ codigo: "MENSAGEM_ENVIADA", rotulo: "Mensagem enviada", ativa: true, ordem: 20, grupo: "CONTATO", retorno_modo: "NENHUM", retorno_dias_uteis: null, proxima_acao: "CONTATAR" }], error: null }) }) };
      },
    });
    await carregarTabulacoes();
    expect(colunasPedidas.length).toBeGreaterThan(0);
    for (const colunas of colunasPedidas) {
      expect(colunas).not.toContain("somente_gestao");
    }
  });
});

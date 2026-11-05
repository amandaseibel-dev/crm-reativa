// Testes puros (sem banco, sem rede) da lógica de staging da integração
// ACORDOS Prime/ULBRA. Dados FICTÍCIOS. Cobre as decisões fechadas nas
// rodadas de diagnóstico e o reconhecimento automático dos cenários de
// renegociação (cancelado-e-refeito, reacordos sucessivos, renegociação
// parcial, composição mista, acordo parcialmente pago renegociado e
// parcela única) — sempre separado do bloqueio financeiro, que nunca libera
// nesta etapa.
import { describe, it, expect } from "vitest";
import {
  montarChaveAcordo,
  hashComposicao,
  compararVersoes,
  classificarCaso,
  montarCadeiaReacordo,
  analisarComposicao,
  temComposicaoMista,
  ehQuitacaoObservada,
  avaliarReconhecimento,
  reconhecerCaptura,
  bloqueioFinanceiroAtivo,
  transformarParaImportarAcordos,
} from "./prime-acordos-staging.ts";

function captura(overrides = {}) {
  return {
    numeroAcordoMannesoft: "71903",
    identificadorAluno: "052.961.800-11",
    carteiraPortador: "166",
    situacaoMannesoft: "ATIVO",
    tipoMannesoft: "Acordo",
    composicao: {
      titulos_negociados: [{ documento: "9000001", vencimento: "2026-05-10" }],
      titulos_gerados: [{ documento: "9000101", vencimento: "2026-06-10" }],
    },
    ...overrides,
  };
}

describe("montarChaveAcordo — identidade estável", () => {
  it("é a mesma chave mesmo quando a carteira muda entre capturas", () => {
    const c1 = captura({ carteiraPortador: "166" });
    const c2 = captura({ carteiraPortador: "195" });
    expect(montarChaveAcordo(c1)).toBe(montarChaveAcordo(c2));
  });

  it("normaliza o CPF (pontuação não afeta a chave)", () => {
    const c1 = captura({ identificadorAluno: "052.961.800-11" });
    const c2 = captura({ identificadorAluno: "05296180011" });
    expect(montarChaveAcordo(c1)).toBe(montarChaveAcordo(c2));
  });

  it("recusa montar chave sem número de acordo ou CPF", () => {
    expect(() => montarChaveAcordo(captura({ numeroAcordoMannesoft: "" }))).toThrow(/CHAVE_ACORDO_INCOMPLETA/);
  });
});

describe("hashComposicao", () => {
  it("é determinístico para a mesma composição", () => {
    const a = captura();
    expect(hashComposicao(a.composicao)).toBe(hashComposicao(captura().composicao));
  });

  it("muda quando a composição muda", () => {
    const a = captura();
    const b = captura({ composicao: { titulos_negociados: [], titulos_gerados: [{ documento: "9999999", vencimento: "2026-01-01" }] } });
    expect(hashComposicao(a.composicao)).not.toBe(hashComposicao(b.composicao));
  });
});

describe("compararVersoes / classificarCaso", () => {
  it("primeira captura é ACORDO_NOVO", () => {
    expect(classificarCaso(null, captura())).toBe("ACORDO_NOVO");
  });

  it("tipo rotulado explicitamente como Reacordo pelo Mannesoft vira REACORDO_ROTULADO, nunca inferido", () => {
    expect(classificarCaso(null, captura({ tipoMannesoft: "Reacordo" }))).toBe("REACORDO_ROTULADO");
  });

  it("mudança de situação entre capturas é detectada", () => {
    const anterior = captura({ situacaoMannesoft: "ATIVO" });
    const atual = captura({ situacaoMannesoft: "CANCELADO" });
    const cmp = compararVersoes(anterior, atual);
    expect(cmp.situacaoMudou).toBe(true);
    expect(cmp.camposAlterados).toContain("situacao_mannesoft");
    expect(classificarCaso(anterior, atual)).toBe("MUDANCA_SITUACAO");
  });

  it("mudança de carteira entre capturas NÃO quebra a identidade — só é reportada como atributo alterado", () => {
    const anterior = captura({ carteiraPortador: "166" });
    const atual = captura({ carteiraPortador: "195" });
    const cmp = compararVersoes(anterior, atual);
    expect(cmp.carteiraMudou).toBe(true);
    expect(cmp.situacaoMudou).toBe(false);
    expect(montarChaveAcordo(anterior)).toBe(montarChaveAcordo(atual));
  });

  it("sem mudança nenhuma entre capturas", () => {
    expect(classificarCaso(captura(), captura())).toBe("SEM_MUDANCA");
  });
});

describe("ehQuitacaoObservada", () => {
  it.each(["QUITADO", "PAGO", "Liquidado", "quitado"])("reconhece %s como quitação observada", (situacao) => {
    expect(ehQuitacaoObservada(situacao)).toBe(true);
  });
  it("não confunde ATIVO ou CANCELADO com quitação", () => {
    expect(ehQuitacaoObservada("ATIVO")).toBe(false);
    expect(ehQuitacaoObservada("CANCELADO")).toBe(false);
  });
  it("parcela única não presume quitação — a regra é só a situação, igual a acordo de várias parcelas (item 6)", () => {
    expect(ehQuitacaoObservada("ATIVO")).toBe(false); // mesmo sem olhar para qtd_parcelas em lugar nenhum do código
    expect(ehQuitacaoObservada("QUITADO")).toBe(true); // só muda pela situação explícita, nunca pela contagem de parcelas
  });
});

describe("1/2. acordo cancelado e refeito / reacordos sucessivos — só por referência explícita", () => {
  it("classifica REACORDO_APOS_CANCELAMENTO com referência explícita ao acordo anterior já confirmado CANCELADO", () => {
    const atual = captura({ numeroAcordoMannesoft: "80002", acordoAnteriorMannesoft: "71903" });
    expect(classificarCaso(null, atual, { situacaoMannesoft: "CANCELADO" })).toBe("REACORDO_APOS_CANCELAMENTO");
  });

  it("não classifica como reacordo encadeado sem referência explícita, mesmo havendo acordo cancelado do mesmo aluno", () => {
    const atual = captura({ numeroAcordoMannesoft: "80003" });
    expect(classificarCaso(null, atual, { situacaoMannesoft: "CANCELADO" })).toBe("ACORDO_NOVO");
  });

  it("não classifica como reacordo encadeado se o acordo referenciado ainda não está confirmado CANCELADO", () => {
    const atual = captura({ numeroAcordoMannesoft: "80004", acordoAnteriorMannesoft: "71903" });
    expect(classificarCaso(null, atual, { situacaoMannesoft: "ATIVO" })).toBe("ACORDO_NOVO");
  });

  it("REACORDO_APOS_CANCELAMENTO bem resolvido (referência encontrada) é reconhecido automaticamente no staging", () => {
    const r = reconhecerCaptura({
      anterior: null,
      atual: captura({ numeroAcordoMannesoft: "80002", acordoAnteriorMannesoft: "71903" }),
      conflitoNaCaptura: false,
      acordoAnterior: { situacaoMannesoft: "CANCELADO" },
      referenciaAcordoAnteriorNaoResolvida: false,
    });
    expect(r.caso).toBe("REACORDO_APOS_CANCELAMENTO");
    expect(r.reconhecimento).toEqual({ classe: "AUTOMATICO", motivo: "RECONHECIMENTO_AUTOMATICO_IDENTIDADE_COMPOSICAO_HISTORICO" });
  });

  it("referência a acordo anterior que o staging não encontra é identidade ambígua — exige conferência", () => {
    const r = reconhecerCaptura({
      anterior: null,
      atual: captura({ numeroAcordoMannesoft: "80002", acordoAnteriorMannesoft: "99999" }),
      conflitoNaCaptura: false,
      acordoAnterior: null,
      referenciaAcordoAnteriorNaoResolvida: true,
    });
    expect(r.reconhecimento.classe).toBe("EXCECAO");
    expect(r.reconhecimento.motivo).toBe("IDENTIDADE_AMBIGUA_REFERENCIA_NAO_RESOLVIDA");
  });
});

describe("montarCadeiaReacordo — renegociações sucessivas (A→B→C)", () => {
  const elos = {
    "MANNESOFT:80003:CPF:05296180011": { chave: "MANNESOFT:80003:CPF:05296180011", acordoAnteriorChave: "MANNESOFT:80002:CPF:05296180011" },
    "MANNESOFT:80002:CPF:05296180011": { chave: "MANNESOFT:80002:CPF:05296180011", acordoAnteriorChave: "MANNESOFT:71903:CPF:05296180011" },
    "MANNESOFT:71903:CPF:05296180011": { chave: "MANNESOFT:71903:CPF:05296180011" }, // sem referência explícita — a cadeia termina aqui
  };
  const buscar = (chave) => elos[chave] ?? null;

  it("segue a cadeia só pelas referências explícitas, do mais novo ao mais antigo", () => {
    const cadeia = montarCadeiaReacordo("MANNESOFT:80003:CPF:05296180011", buscar);
    expect(cadeia).toEqual([
      "MANNESOFT:80003:CPF:05296180011",
      "MANNESOFT:80002:CPF:05296180011",
      "MANNESOFT:71903:CPF:05296180011",
    ]);
  });

  it("para numa chave sem elo registrado, sem presumir continuidade", () => {
    const cadeia = montarCadeiaReacordo("MANNESOFT:99999:CPF:05296180011", buscar);
    expect(cadeia).toEqual(["MANNESOFT:99999:CPF:05296180011"]);
  });

  it("não entra em loop se houver referência circular", () => {
    const circular = { A: { chave: "A", acordoAnteriorChave: "B" }, B: { chave: "B", acordoAnteriorChave: "A" } };
    const cadeia = montarCadeiaReacordo("A", (c) => circular[c] ?? null);
    expect(cadeia).toEqual(["A", "B"]);
  });
});

describe("3. renegociação de uma ou várias parcelas de acordo anterior", () => {
  it("reconhece a presença de parcela(s) herdada(s) quando a origem e a referência são explícitas", () => {
    const composicao = {
      titulos_negociados: [
        { documento: "1", origem: "MENSALIDADE_ORIGINAL" },
        { documento: "2", origem: "PARCELA_DE_ACORDO_ANTERIOR", acordoOrigemMannesoft: "71903" },
        { documento: "3", origem: "PARCELA_DE_ACORDO_ANTERIOR", acordoOrigemMannesoft: "71903" },
      ],
      titulos_gerados: [{ documento: "9" }],
    };
    const tracos = analisarComposicao(composicao);
    expect(tracos.temParcelaDeAcordoAnterior).toBe(true);
    expect(tracos.acordoOrigemReferenciasDivergentes).toBe(false); // mesma origem nas duas parcelas herdadas
    expect(tracos.algumaParcelaDeAcordoAnteriorSemReferencia).toBe(false);
  });

  it("renegociação parcial bem resolvida é reconhecida automaticamente no staging", () => {
    const composicao = {
      titulos_negociados: [{ documento: "2", origem: "PARCELA_DE_ACORDO_ANTERIOR", acordoOrigemMannesoft: "71903" }],
      titulos_gerados: [{ documento: "9" }],
    };
    const r = avaliarReconhecimento({ conflitoNaCaptura: false, tracos: analisarComposicao(composicao) });
    expect(r.classe).toBe("AUTOMATICO");
  });

  it("parcela herdada SEM dizer de qual acordo vem é informação insuficiente — exige conferência", () => {
    const composicao = {
      titulos_negociados: [{ documento: "2", origem: "PARCELA_DE_ACORDO_ANTERIOR" }], // sem acordoOrigemMannesoft
      titulos_gerados: [{ documento: "9" }],
    };
    const tracos = analisarComposicao(composicao);
    expect(tracos.algumaParcelaDeAcordoAnteriorSemReferencia).toBe(true);
    const r = avaliarReconhecimento({ conflitoNaCaptura: false, tracos });
    expect(r.classe).toBe("EXCECAO");
    expect(r.motivo).toBe("INFORMACAO_INSUFICIENTE_ORIGEM_DO_TITULO_SEM_REFERENCIA");
  });

  it("parcelas herdadas referenciando MAIS DE UM acordo de origem é composição divergente — exige conferência", () => {
    const composicao = {
      titulos_negociados: [
        { documento: "2", origem: "PARCELA_DE_ACORDO_ANTERIOR", acordoOrigemMannesoft: "71903" },
        { documento: "3", origem: "PARCELA_DE_ACORDO_ANTERIOR", acordoOrigemMannesoft: "72000" },
      ],
      titulos_gerados: [{ documento: "9" }],
    };
    const tracos = analisarComposicao(composicao);
    expect(tracos.acordoOrigemReferenciasDivergentes).toBe(true);
    const r = avaliarReconhecimento({ conflitoNaCaptura: false, tracos });
    expect(r.classe).toBe("EXCECAO");
    expect(r.motivo).toBe("COMPOSICAO_DIVERGENTE_MULTIPLOS_ACORDOS_DE_ORIGEM");
  });
});

describe("4. negociações que reúnem mensalidades e parcelas de acordos (composição mista)", () => {
  it("é mista quando há mensalidade original e parcela herdada no mesmo grupo", () => {
    const composicao = {
      titulos_negociados: [
        { documento: "1", origem: "MENSALIDADE_ORIGINAL" },
        { documento: "2", origem: "PARCELA_DE_ACORDO_ANTERIOR", acordoOrigemMannesoft: "71903" },
      ],
      titulos_gerados: [],
    };
    expect(temComposicaoMista(composicao)).toBe(true);
  });

  it("não é mista quando todos os títulos negociados têm a mesma origem explícita", () => {
    const composicao = {
      titulos_negociados: [{ documento: "1", origem: "MENSALIDADE_ORIGINAL" }, { documento: "2", origem: "MENSALIDADE_ORIGINAL" }],
      titulos_gerados: [],
    };
    expect(temComposicaoMista(composicao)).toBe(false);
  });

  it("origem INDETERMINADA ou ausente nunca conta como mista nem como pura — não inventa distinção que a captura não deu", () => {
    const composicao = { titulos_negociados: [{ documento: "1" }, { documento: "2", origem: "INDETERMINADA" }], titulos_gerados: [] };
    expect(temComposicaoMista(composicao)).toBe(false);
  });

  it("composição mista bem resolvida (sem divergência nem referência faltando) é reconhecida automaticamente no staging", () => {
    const composicao = {
      titulos_negociados: [
        { documento: "1", origem: "MENSALIDADE_ORIGINAL" },
        { documento: "2", origem: "PARCELA_DE_ACORDO_ANTERIOR", acordoOrigemMannesoft: "71903" },
      ],
      titulos_gerados: [{ documento: "9" }],
    };
    const r = avaliarReconhecimento({ conflitoNaCaptura: false, tracos: analisarComposicao(composicao) });
    expect(r.classe).toBe("AUTOMATICO");
  });
});

describe("5. acordo parcialmente pago que passa por renegociação", () => {
  it("reconhecerCaptura expõe o traço renegociacaoDeAcordoParcialmentePago só quando o chamador informa explicitamente", () => {
    const comPagamento = reconhecerCaptura({
      anterior: null,
      atual: captura({ numeroAcordoMannesoft: "80002", acordoAnteriorMannesoft: "71903" }),
      conflitoNaCaptura: false,
      acordoAnterior: { situacaoMannesoft: "CANCELADO", teveParcelaPagaOuBaixaViva: true },
    });
    expect(comPagamento.tracos.renegociacaoDeAcordoParcialmentePago).toBe(true);

    const semPagamento = reconhecerCaptura({
      anterior: null,
      atual: captura({ numeroAcordoMannesoft: "80002", acordoAnteriorMannesoft: "71903" }),
      conflitoNaCaptura: false,
      acordoAnterior: { situacaoMannesoft: "CANCELADO", teveParcelaPagaOuBaixaViva: false },
    });
    expect(semPagamento.tracos.renegociacaoDeAcordoParcialmentePago).toBe(false);
  });

  it("acordo parcialmente pago renegociado continua reconhecido automaticamente no staging — o traço é só informativo", () => {
    const r = reconhecerCaptura({
      anterior: null,
      atual: captura({ numeroAcordoMannesoft: "80002", acordoAnteriorMannesoft: "71903" }),
      conflitoNaCaptura: false,
      acordoAnterior: { situacaoMannesoft: "CANCELADO", teveParcelaPagaOuBaixaViva: true },
      referenciaAcordoAnteriorNaoResolvida: false,
    });
    expect(r.reconhecimento.classe).toBe("AUTOMATICO");
  });
});

describe("6. acordo de parcela única — sem presumir quitação", () => {
  it("analisarComposicao marca parcelaUnica só pela contagem de títulos gerados, nunca pela situação", () => {
    const composicaoUnica = { titulos_negociados: [{ documento: "1" }], titulos_gerados: [{ documento: "9" }] };
    const composicaoMultipla = { titulos_negociados: [{ documento: "1" }], titulos_gerados: [{ documento: "9" }, { documento: "10" }] };
    expect(analisarComposicao(composicaoUnica).parcelaUnica).toBe(true);
    expect(analisarComposicao(composicaoMultipla).parcelaUnica).toBe(false);
  });

  it("acordo de parcela única ATIVO não é tratado como quitação, e reconhecimento segue automático", () => {
    const atual = captura({ situacaoMannesoft: "ATIVO", composicao: { titulos_negociados: [{ documento: "1" }], titulos_gerados: [{ documento: "9" }] } });
    expect(ehQuitacaoObservada(atual.situacaoMannesoft)).toBe(false);
    const r = reconhecerCaptura({ anterior: null, atual, conflitoNaCaptura: false });
    expect(r.tracos.parcelaUnica).toBe(true);
    expect(r.reconhecimento.classe).toBe("AUTOMATICO");
  });

  it("acordo de parcela única QUITADO é tratado como qualquer outra quitação observada — alerta no bloqueio financeiro, nunca baixa", () => {
    expect(ehQuitacaoObservada("QUITADO")).toBe(true);
    expect(bloqueioFinanceiroAtivo("QUITADO")).toEqual({ bloqueado: true, motivo: "QUITACAO_OBSERVADA_EXTERNA_NUNCA_GERA_BAIXA_AUTOMATICA" });
  });
});

describe("avaliarReconhecimento — fail-closed restrito a identidade ambígua / composição divergente / informação insuficiente", () => {
  it("colisão de chave no lote é sempre exceção", () => {
    const r = avaliarReconhecimento({ conflitoNaCaptura: true, tracos: analisarComposicao(captura().composicao) });
    expect(r).toEqual({ classe: "EXCECAO", motivo: "COLISAO_CHAVE_NO_LOTE" });
  });

  it("captura simples, sem nenhuma ambiguidade, é automática", () => {
    const r = avaliarReconhecimento({ conflitoNaCaptura: false, tracos: analisarComposicao(captura().composicao) });
    expect(r.classe).toBe("AUTOMATICO");
  });
});

describe("bloqueioFinanceiroAtivo — sempre bloqueado nesta etapa, para todo caso", () => {
  it.each(["ATIVO", "CANCELADO", "QUITADO", "QUALQUER_OUTRA_COISA"])("nunca libera para situação %s", (situacao) => {
    expect(bloqueioFinanceiroAtivo(situacao).bloqueado).toBe(true);
  });

  it("reconhecimento automático no staging nunca implica bloqueio financeiro liberado", () => {
    const r = reconhecerCaptura({ anterior: null, atual: captura(), conflitoNaCaptura: false });
    expect(r.reconhecimento.classe).toBe("AUTOMATICO");
    expect(bloqueioFinanceiroAtivo(captura().situacaoMannesoft).bloqueado).toBe(true);
  });
});

describe("transformarParaImportarAcordos — proposta, não contrato comprovado", () => {
  it("sempre devolve pendências de validação junto com a linha proposta", () => {
    const r = transformarParaImportarAcordos(captura(), { documento: "9000101", vencimento: "2026-06-10", valor: 500.5 });
    expect(r.linhas).toHaveLength(1);
    expect(r.linhas[0].cpf).toBe("05296180011");
    expect(r.pendenciasValidacao.length).toBeGreaterThan(0);
  });
});

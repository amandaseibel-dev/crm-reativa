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
  ehPortadorReativa,
  ehVinculoContraditorio,
  avaliarVinculoConvenioReativa,
  avaliarReconhecimento,
  reconhecerCaptura,
  bloqueioFinanceiroAtivo,
  transformarParaImportarAcordos,
} from "./prime-acordos-staging.ts";

// Título gerado "de livro" do acordo: boleto emitido sob o convênio
// Santander ReATIVA (166/0272047) — usado como padrão nos fixtures que não
// estão testando o vínculo com o convênio em si, para não contaminar
// asserções de outros cenários.
function tituloGeradoReativa(overrides = {}) {
  return { documento: "9000101", vencimento: "2026-06-10", portadorIdMannesoft: 166, convenioMannesoft: "0272047", ...overrides };
}

function captura(overrides = {}) {
  return {
    numeroAcordoMannesoft: "71903",
    identificadorAluno: "052.961.800-11",
    carteiraPortador: "166",
    situacaoMannesoft: "ATIVO",
    tipoMannesoft: "Acordo",
    composicao: {
      titulos_negociados: [{ documento: "9000001", vencimento: "2026-05-10" }],
      titulos_gerados: [tituloGeradoReativa()],
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
      titulos_gerados: [tituloGeradoReativa()],
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
      titulos_gerados: [tituloGeradoReativa()],
    };
    const r = avaliarReconhecimento({ conflitoNaCaptura: false, tracos: analisarComposicao(composicao) });
    expect(r.classe).toBe("AUTOMATICO");
  });

  it("negociação mista preserva, SEM filtrar, os portadores de ORIGEM diferentes dos títulos negociados — mensalidade e parcela herdada podem vir de qualquer portador", () => {
    const composicao = {
      titulos_negociados: [
        { documento: "1", origem: "MENSALIDADE_ORIGINAL", portadorIdMannesoft: 195, convenioMannesoft: null },
        { documento: "2", origem: "PARCELA_DE_ACORDO_ANTERIOR", acordoOrigemMannesoft: "71903", portadorIdMannesoft: 95, convenioMannesoft: "0272036" },
      ],
      titulos_gerados: [tituloGeradoReativa()],
    };
    // nenhum dado de portador do título negociado é alterado, descartado ou usado para excluir a negociação
    expect(composicao.titulos_negociados[0].portadorIdMannesoft).toBe(195);
    expect(composicao.titulos_negociados[1].portadorIdMannesoft).toBe(95);
    const r = avaliarReconhecimento({ conflitoNaCaptura: false, tracos: analisarComposicao(composicao) });
    expect(r.classe).toBe("AUTOMATICO"); // o vínculo com 166/272047 é comprovado pelo título GERADO, não pelos negociados
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
    const atual = captura({ situacaoMannesoft: "ATIVO", composicao: { titulos_negociados: [{ documento: "1" }], titulos_gerados: [tituloGeradoReativa({ documento: "9" })] } });
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

describe("ehPortadorReativa / avaliarVinculoConvenioReativa — convênio 272047, portador 166", () => {
  it("reconhece por portadorIdMannesoft = 166, mesmo sem convênio informado", () => {
    expect(ehPortadorReativa({ portadorIdMannesoft: 166, convenioMannesoft: null })).toBe(true);
  });

  it("reconhece por convenioMannesoft = 0272047 (com zero à esquerda), mesmo sem portadorId informado", () => {
    expect(ehPortadorReativa({ portadorIdMannesoft: null, convenioMannesoft: "0272047" })).toBe(true);
  });

  it("reconhece convênio sem zero à esquerda (272047) — a comparação normaliza, mas o valor bruto não é alterado no objeto", () => {
    const titulo = { portadorIdMannesoft: null, convenioMannesoft: "272047" };
    expect(ehPortadorReativa(titulo)).toBe(true);
    expect(titulo.convenioMannesoft).toBe("272047"); // preservado como veio, nunca normalizado no dado
  });

  it("não reconhece outro portador Santander (95/272036, 160/272037) nem judiciais (165, 202) como ReATIVA", () => {
    expect(ehPortadorReativa({ portadorIdMannesoft: 95, convenioMannesoft: "0272036" })).toBe(false);
    expect(ehPortadorReativa({ portadorIdMannesoft: 160, convenioMannesoft: "0272037" })).toBe(false);
    expect(ehPortadorReativa({ portadorIdMannesoft: 165, convenioMannesoft: null })).toBe(false);
    expect(ehPortadorReativa({ portadorIdMannesoft: 202, convenioMannesoft: null })).toBe(false);
  });

  it("não reconhece nada sem informação nenhuma (nem portador, nem convênio) — nunca presume", () => {
    expect(ehPortadorReativa({})).toBe(false);
    expect(ehPortadorReativa({ portadorIdMannesoft: null, convenioMannesoft: null })).toBe(false);
  });

  it("suficiente só quando TODOS os títulos gerados informam e casam com 166/272047", () => {
    expect(avaliarVinculoConvenioReativa([tituloGeradoReativa()])).toEqual({ suficiente: true, divergente: false, semInformacao: false });
    expect(avaliarVinculoConvenioReativa([tituloGeradoReativa(), tituloGeradoReativa({ documento: "9000102" })])).toEqual({
      suficiente: true,
      divergente: false,
      semInformacao: false,
    });
  });

  it("sem nenhum título gerado é informação insuficiente — nunca presumido ReATIVA", () => {
    expect(avaliarVinculoConvenioReativa([])).toEqual({ suficiente: false, divergente: false, semInformacao: true });
  });

  it("título gerado sem portador nem convênio é informação insuficiente", () => {
    expect(avaliarVinculoConvenioReativa([{ documento: "9" }])).toEqual({ suficiente: false, divergente: false, semInformacao: true });
  });

  it("título gerado com portador/convênio divergente de 166/272047 é divergência, não insuficiência", () => {
    expect(avaliarVinculoConvenioReativa([{ documento: "9", portadorIdMannesoft: 95, convenioMannesoft: "0272036" }])).toEqual({
      suficiente: false,
      divergente: true,
      semInformacao: false,
    });
  });

  it("um título gerado divergente entre vários ReATIVA já torna o vínculo insuficiente (fail-closed)", () => {
    const r = avaliarVinculoConvenioReativa([tituloGeradoReativa(), { documento: "9000103", portadorIdMannesoft: 195, convenioMannesoft: null }]);
    expect(r.suficiente).toBe(false);
    expect(r.divergente).toBe(true);
  });

  // --------------------------------------------------------------------------
  // REGRESSÃO — evidência CONTRADITÓRIA dentro do mesmo título gerado.
  // Antes desta correção `ehPortadorReativa` usava OR, então portador 166 com
  // convênio 272036 (sinais que discordam) retornava true e o vínculo vinha
  // `suficiente` — comprovava vínculo a partir de evidência contra ele.
  // Agora contradição é divergência, e divergência é EXCECAO.
  // --------------------------------------------------------------------------
  it("portador 166 com convênio comprovadamente divergente é CONTRADIÇÃO, não vínculo", () => {
    expect(ehVinculoContraditorio({ portadorIdMannesoft: 166, convenioMannesoft: "0272036" })).toBe(true);
    const r = avaliarVinculoConvenioReativa([{ documento: "9", portadorIdMannesoft: 166, convenioMannesoft: "0272036" }]);
    expect(r).toEqual({ suficiente: false, divergente: true, semInformacao: false });
  });

  it("o inverso também é contradição: convênio 272047 com portador que não é 166", () => {
    expect(ehVinculoContraditorio({ portadorIdMannesoft: 95, convenioMannesoft: "0272047" })).toBe(true);
    const r = avaliarVinculoConvenioReativa([{ documento: "9", portadorIdMannesoft: 95, convenioMannesoft: "0272047" }]);
    expect(r).toEqual({ suficiente: false, divergente: true, semInformacao: false });
  });

  it("um título contraditório entre vários coerentes derruba o vínculo inteiro (fail-closed)", () => {
    const r = avaliarVinculoConvenioReativa([
      tituloGeradoReativa(),
      { documento: "9000104", portadorIdMannesoft: 166, convenioMannesoft: "0272036" },
    ]);
    expect(r.suficiente).toBe(false);
    expect(r.divergente).toBe(true);
  });

  it("OMISSÃO não é contradição — critério de evidência ausente permanece inalterado", () => {
    // só um dos dois sinais informado: segue valendo ehPortadorReativa, e o
    // vínculo segue suficiente. Esta correção não endureceu este caso.
    expect(ehVinculoContraditorio({ portadorIdMannesoft: 166, convenioMannesoft: null })).toBe(false);
    expect(ehVinculoContraditorio({ portadorIdMannesoft: null, convenioMannesoft: "0272047" })).toBe(false);
    expect(ehVinculoContraditorio({})).toBe(false);
    expect(avaliarVinculoConvenioReativa([{ documento: "9", portadorIdMannesoft: 166, convenioMannesoft: null }])).toEqual({
      suficiente: true,
      divergente: false,
      semInformacao: false,
    });
  });

  it("os dois sinais coerentes seguem comprovando vínculo (166 + 272047, com e sem zero à esquerda)", () => {
    expect(ehVinculoContraditorio({ portadorIdMannesoft: 166, convenioMannesoft: "0272047" })).toBe(false);
    expect(ehVinculoContraditorio({ portadorIdMannesoft: 166, convenioMannesoft: "272047" })).toBe(false);
    expect(ehVinculoContraditorio({ portadorIdMannesoft: 95, convenioMannesoft: "0272036" })).toBe(false);
  });

  it("NÃO usa a filiação geral do aluno ao portador 166 — avalia só os títulos gerados passados, nada além disso", () => {
    // mesmo que, em outro lugar do CRM, o aluno tenha filiação ao 166, a
    // função não recebe nem consulta esse dado — só o array de titulos_gerados
    // do PRÓPRIO acordo em avaliação.
    expect(avaliarVinculoConvenioReativa([{ documento: "9" }]).suficiente).toBe(false);
  });
});

describe("3/5. validação do convênio 272047/portador 166 como destino, e exceção quando não comprovado", () => {
  it("acordo simples com boleto gerado comprovadamente no 166/0272047 é reconhecido automaticamente", () => {
    const r = reconhecerCaptura({ anterior: null, atual: captura(), conflitoNaCaptura: false });
    expect(r.reconhecimento).toEqual({ classe: "AUTOMATICO", motivo: "RECONHECIMENTO_AUTOMATICO_IDENTIDADE_COMPOSICAO_HISTORICO" });
  });

  it("acordo simples cujo boleto gerado não informa portador nem convênio vai para conferência — nunca presumido ReATIVA", () => {
    const atual = captura({ composicao: { titulos_negociados: [{ documento: "1" }], titulos_gerados: [{ documento: "9" }] } });
    const r = reconhecerCaptura({ anterior: null, atual, conflitoNaCaptura: false });
    expect(r.reconhecimento).toEqual({ classe: "EXCECAO", motivo: "VINCULO_CONVENIO_REATIVA_SEM_INFORMACAO" });
  });

  it("acordo simples cujo boleto gerado está noutro convênio Santander (95/272036, fora do escopo Reativa) vai para conferência", () => {
    const atual = captura({
      composicao: {
        titulos_negociados: [{ documento: "1" }],
        titulos_gerados: [{ documento: "9", portadorIdMannesoft: 95, convenioMannesoft: "0272036" }],
      },
    });
    const r = reconhecerCaptura({ anterior: null, atual, conflitoNaCaptura: false });
    expect(r.reconhecimento).toEqual({ classe: "EXCECAO", motivo: "VINCULO_CONVENIO_REATIVA_DIVERGENTE" });
  });

  it("não considera o acordo da ReATIVA só porque, em algum outro lugar, o aluno tem filiação ao 166 — exige evidência no PRÓPRIO acordo", () => {
    // simula um acordo cujo próprio título gerado nada informa, mesmo que o
    // chamador "soubesse" que o aluno tem filiação ao 166 em outro contexto —
    // essa informação nunca entra na função, e o resultado é conferência.
    const atual = captura({ composicao: { titulos_negociados: [{ documento: "1" }], titulos_gerados: [{ documento: "9" }] } });
    const r = reconhecerCaptura({ anterior: null, atual, conflitoNaCaptura: false });
    expect(r.reconhecimento.classe).toBe("EXCECAO");
  });
});

describe("4. preservação de títulos originais de outros portadores (mensalidade e parcela de acordo anterior)", () => {
  it("preserva o portador/convênio bruto de uma mensalidade original vinda de outro portador (195), sem filtrar nem excluir", () => {
    const composicao = {
      titulos_negociados: [{ documento: "1", origem: "MENSALIDADE_ORIGINAL", portadorIdMannesoft: 195, convenioMannesoft: null }],
      titulos_gerados: [tituloGeradoReativa()],
    };
    expect(composicao.titulos_negociados[0].portadorIdMannesoft).toBe(195);
    const r = avaliarReconhecimento({ conflitoNaCaptura: false, tracos: analisarComposicao(composicao) });
    expect(r.classe).toBe("AUTOMATICO");
  });

  it("preserva o portador bruto de uma parcela herdada de acordo anterior vinda de um portador qualquer, sem lista rígida de origem", () => {
    const composicao = {
      titulos_negociados: [
        { documento: "2", origem: "PARCELA_DE_ACORDO_ANTERIOR", acordoOrigemMannesoft: "71903", portadorIdMannesoft: 166, convenioMannesoft: "0272047" },
      ],
      titulos_gerados: [tituloGeradoReativa()],
    };
    expect(composicao.titulos_negociados[0].portadorIdMannesoft).toBe(166);
    const r = avaliarReconhecimento({ conflitoNaCaptura: false, tracos: analisarComposicao(composicao) });
    expect(r.classe).toBe("AUTOMATICO");
  });

  it("título negociado com portador totalmente desconhecido/inusual (fora de qualquer lista) ainda é reconhecido — não há lista rígida de origem", () => {
    const composicao = {
      titulos_negociados: [{ documento: "1", origem: "MENSALIDADE_ORIGINAL", portadorIdMannesoft: 999999, convenioMannesoft: "9999999" }],
      titulos_gerados: [tituloGeradoReativa()],
    };
    const r = avaliarReconhecimento({ conflitoNaCaptura: false, tracos: analisarComposicao(composicao) });
    expect(r.classe).toBe("AUTOMATICO"); // o vínculo é comprovado pelo gerado; o portador de origem nunca é filtro
  });
});

describe("6. registro e comparação de mudança de portador/convênio entre versões", () => {
  it("compararVersoes expõe vinculoConvenioMudou quando o boleto gerado passa a divergir do convênio ReATIVA entre capturas", () => {
    const anterior = captura();
    const atual = captura({
      composicao: {
        titulos_negociados: [{ documento: "9000001", vencimento: "2026-05-10" }],
        titulos_gerados: [{ documento: "9000101", vencimento: "2026-06-10", portadorIdMannesoft: 95, convenioMannesoft: "0272036" }],
      },
    });
    const cmp = compararVersoes(anterior, atual);
    expect(cmp.vinculoConvenioMudou).toBe(true);
    expect(cmp.camposAlterados).toContain("vinculo_convenio_reativa");
  });

  it("vinculoConvenioMudou é false quando o vínculo permanece igualmente suficiente entre capturas, mesmo com outro boleto", () => {
    const anterior = captura();
    const atual = captura({
      composicao: {
        titulos_negociados: [{ documento: "9000001", vencimento: "2026-05-10" }],
        titulos_gerados: [tituloGeradoReativa({ documento: "9000199" })],
      },
    });
    const cmp = compararVersoes(anterior, atual);
    expect(cmp.vinculoConvenioMudou).toBe(false);
  });

  it("carteiraMudou (atributo livre do acordo) e vinculoConvenioMudou (evidência estrutural) são sinais independentes", () => {
    const anterior = captura({ carteiraPortador: "166" });
    const atual = captura({ carteiraPortador: "195" }); // mesma composição/titulos_gerados ReATIVA — só o texto livre mudou
    const cmp = compararVersoes(anterior, atual);
    expect(cmp.carteiraMudou).toBe(true);
    expect(cmp.vinculoConvenioMudou).toBe(false);
  });
});

describe("7. cenários combinados com portador/convênio — simples, cancelado-e-refeito, reacordos sucessivos, mista", () => {
  it("acordo simples (ACORDO_NOVO) com vínculo ReATIVA comprovado: automático", () => {
    const r = reconhecerCaptura({ anterior: null, atual: captura(), conflitoNaCaptura: false });
    expect(r.caso).toBe("ACORDO_NOVO");
    expect(r.reconhecimento.classe).toBe("AUTOMATICO");
  });

  it("acordo cancelado e refeito (REACORDO_APOS_CANCELAMENTO) com vínculo ReATIVA comprovado: automático", () => {
    const r = reconhecerCaptura({
      anterior: null,
      atual: captura({ numeroAcordoMannesoft: "80002", acordoAnteriorMannesoft: "71903" }),
      conflitoNaCaptura: false,
      acordoAnterior: { situacaoMannesoft: "CANCELADO" },
    });
    expect(r.caso).toBe("REACORDO_APOS_CANCELAMENTO");
    expect(r.reconhecimento.classe).toBe("AUTOMATICO");
  });

  it("acordo cancelado e refeito SEM vínculo ReATIVA comprovado no boleto novo: conferência, mesmo com a cadeia bem resolvida", () => {
    const atual = captura({
      numeroAcordoMannesoft: "80002",
      acordoAnteriorMannesoft: "71903",
      composicao: { titulos_negociados: [{ documento: "1" }], titulos_gerados: [{ documento: "9" }] }, // sem portador/convênio
    });
    const r = reconhecerCaptura({ anterior: null, atual, conflitoNaCaptura: false, acordoAnterior: { situacaoMannesoft: "CANCELADO" } });
    expect(r.caso).toBe("REACORDO_APOS_CANCELAMENTO");
    expect(r.reconhecimento.classe).toBe("EXCECAO");
    expect(r.reconhecimento.motivo).toBe("VINCULO_CONVENIO_REATIVA_SEM_INFORMACAO");
  });

  it("reacordos sucessivos (cadeia A→B→C) com vínculo ReATIVA comprovado em cada captura: automático", () => {
    const r = reconhecerCaptura({
      anterior: null,
      atual: captura({ numeroAcordoMannesoft: "80003", acordoAnteriorMannesoft: "80002" }),
      conflitoNaCaptura: false,
      acordoAnterior: { situacaoMannesoft: "CANCELADO" },
    });
    expect(r.reconhecimento.classe).toBe("AUTOMATICO");
  });

  it("negociação mista (mensalidade em 195 + parcela herdada em 166 + boleto novo em 166/272047): automático — a origem não é filtrada", () => {
    const atual = captura({
      composicao: {
        titulos_negociados: [
          { documento: "1", origem: "MENSALIDADE_ORIGINAL", portadorIdMannesoft: 195, convenioMannesoft: null },
          { documento: "2", origem: "PARCELA_DE_ACORDO_ANTERIOR", acordoOrigemMannesoft: "71903", portadorIdMannesoft: 166, convenioMannesoft: "0272047" },
        ],
        titulos_gerados: [tituloGeradoReativa()],
      },
    });
    const r = reconhecerCaptura({ anterior: null, atual, conflitoNaCaptura: false });
    expect(r.tracos.composicaoMista).toBe(true);
    expect(r.reconhecimento.classe).toBe("AUTOMATICO");
  });

  it("negociação mista cujo boleto novo gerado diverge do convênio ReATIVA: conferência, mesmo a composição estando bem formada", () => {
    const atual = captura({
      composicao: {
        titulos_negociados: [
          { documento: "1", origem: "MENSALIDADE_ORIGINAL", portadorIdMannesoft: 195, convenioMannesoft: null },
          { documento: "2", origem: "PARCELA_DE_ACORDO_ANTERIOR", acordoOrigemMannesoft: "71903", portadorIdMannesoft: 166, convenioMannesoft: "0272047" },
        ],
        titulos_gerados: [{ documento: "9", portadorIdMannesoft: 160, convenioMannesoft: "0272037" }],
      },
    });
    const r = reconhecerCaptura({ anterior: null, atual, conflitoNaCaptura: false });
    expect(r.tracos.composicaoMista).toBe(true);
    expect(r.reconhecimento).toEqual({ classe: "EXCECAO", motivo: "VINCULO_CONVENIO_REATIVA_DIVERGENTE" });
  });
});

describe("PARCIAL — identidade/vínculo comprovados, composição completa desconhecida (pagamento observado)", () => {
  // Molde de captura típico de um pagamento Santander observado: identidade
  // (número do acordo + CPF) e vínculo com o convênio ReATIVA comprovados
  // pelo próprio dado bancário de origem (não pelo formato do boleto), mas
  // SEM nenhum título negociado informado — a composição completa nunca vem
  // de um pagamento isolado.
  function capturaDePagamentoObservado(overrides = {}) {
    return captura({
      composicao: {
        titulos_negociados: [], // nunca conhecido só por um pagamento
        titulos_gerados: [tituloGeradoReativa()], // boleto identificado, convênio comprovado pelo arquivo bancário
      },
      ...overrides,
    });
  }

  it("captura COMPLETA (títulos negociados informados) continua AUTOMATICO — não regride", () => {
    const r = reconhecerCaptura({ anterior: null, atual: captura(), conflitoNaCaptura: false });
    expect(r.tracos.composicaoCompletaDesconhecida).toBe(false);
    expect(r.reconhecimento).toEqual({ classe: "AUTOMATICO", motivo: "RECONHECIMENTO_AUTOMATICO_IDENTIDADE_COMPOSICAO_HISTORICO" });
  });

  it("captura PARCIAL (só pagamento observado, vínculo comprovado, sem título negociado) nunca é EXCECAO nem AUTOMATICO", () => {
    const atual = capturaDePagamentoObservado();
    const r = reconhecerCaptura({ anterior: null, atual, conflitoNaCaptura: false });
    expect(r.tracos.composicaoCompletaDesconhecida).toBe(true);
    expect(r.reconhecimento).toEqual({ classe: "PARCIAL", motivo: "COMPOSICAO_COMPLETA_DESCONHECIDA_PENDENTE_COMPLEMENTACAO" });
  });

  it("identidade registrável diretamente por avaliarReconhecimento, sem passar por reconhecerCaptura", () => {
    const composicao = { titulos_negociados: [], titulos_gerados: [tituloGeradoReativa()] };
    const r = avaliarReconhecimento({ conflitoNaCaptura: false, tracos: analisarComposicao(composicao) });
    expect(r.classe).toBe("PARCIAL");
  });

  it("PARCIAL com CONVÊNIO DIVERGENTE no boleto pago vira EXCECAO, nunca PARCIAL — vínculo não comprovado tem prioridade sobre composição desconhecida", () => {
    const atual = capturaDePagamentoObservado({
      composicao: { titulos_negociados: [], titulos_gerados: [{ documento: "9", portadorIdMannesoft: 95, convenioMannesoft: "0272036" }] },
    });
    const r = reconhecerCaptura({ anterior: null, atual, conflitoNaCaptura: false });
    expect(r.reconhecimento).toEqual({ classe: "EXCECAO", motivo: "VINCULO_CONVENIO_REATIVA_DIVERGENTE" });
  });

  it("PARCIAL com AUSÊNCIA DE INFORMAÇÃO de portador/convênio no boleto pago vira EXCECAO, nunca PARCIAL", () => {
    const atual = capturaDePagamentoObservado({
      composicao: { titulos_negociados: [], titulos_gerados: [{ documento: "9" }] }, // sem portador nem convênio
    });
    const r = reconhecerCaptura({ anterior: null, atual, conflitoNaCaptura: false });
    expect(r.reconhecimento).toEqual({ classe: "EXCECAO", motivo: "VINCULO_CONVENIO_REATIVA_SEM_INFORMACAO" });
  });

  it("PARCIAL não é encaminhada à conferência — bloqueioFinanceiroAtivo segue bloqueado do mesmo jeito, nunca liberado por ser identidade comprovada", () => {
    const atual = capturaDePagamentoObservado();
    const r = reconhecerCaptura({ anterior: null, atual, conflitoNaCaptura: false });
    expect(r.reconhecimento.classe).toBe("PARCIAL");
    expect(bloqueioFinanceiroAtivo(atual.situacaoMannesoft).bloqueado).toBe(true);
  });

  it("PARCIAL nunca presume quitação, cancelamento, quantidade total de parcelas ou vínculo com mensalidade original", () => {
    const atual = capturaDePagamentoObservado({ situacaoMannesoft: "ATIVO" });
    const r = reconhecerCaptura({ anterior: null, atual, conflitoNaCaptura: false });
    expect(r.reconhecimento.classe).toBe("PARCIAL");
    // nenhum traço de quitação, cancelamento ou vínculo com mensalidade é
    // derivado — só o que a composição (vazia) e a situação crua permitem:
    expect(ehQuitacaoObservada(atual.situacaoMannesoft)).toBe(false);
    expect(r.tracos.temParcelaDeAcordoAnterior).toBe(false); // não inferido; composição vazia não autoriza afirmar nada
    expect(r.tracos.composicaoMista).toBe(false); // idem — ausência de dado não é "mensalidade pura"
    expect(bloqueioFinanceiroAtivo(atual.situacaoMannesoft).bloqueado).toBe(true);
  });

  it("PARCIAL encadeado (pagamento observado referenciando acordo anterior resolvido) ainda assim não vira AUTOMATICO — composição continua desconhecida", () => {
    const atual = capturaDePagamentoObservado({ numeroAcordoMannesoft: "80002", acordoAnteriorMannesoft: "71903" });
    const r = reconhecerCaptura({
      anterior: null,
      atual,
      conflitoNaCaptura: false,
      acordoAnterior: { situacaoMannesoft: "CANCELADO" },
    });
    expect(r.caso).toBe("REACORDO_APOS_CANCELAMENTO");
    expect(r.reconhecimento.classe).toBe("PARCIAL");
  });

  it("filiação ao portador 166 sozinha, sem número de acordo, não produz nenhuma captura (regra 9) — montarChaveAcordo recusa", () => {
    expect(() => montarChaveAcordo({ numeroAcordoMannesoft: "", identificadorAluno: "052.961.800-11" })).toThrow(/CHAVE_ACORDO_INCOMPLETA/);
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

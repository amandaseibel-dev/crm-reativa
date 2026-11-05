// Testes puros (sem banco, sem rede) da lógica de staging da integração
// ACORDOS Prime/ULBRA. Dados FICTÍCIOS. Cobre exatamente as decisões já
// fechadas nas rodadas de diagnóstico: identidade sem carteira, composição
// como grupo, quitação sempre alerta, fail-closed no indeterminado.
import { describe, it, expect } from "vitest";
import {
  montarChaveAcordo,
  hashComposicao,
  compararVersoes,
  classificarCaso,
  montarCadeiaReacordo,
  temComposicaoMista,
  ehQuitacaoObservada,
  avaliarSeguranca,
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
});

describe("avaliarSeguranca — fail-closed", () => {
  it("conflito na captura é sempre exceção, mesmo em acordo novo", () => {
    const r = avaliarSeguranca({ conflitoNaCaptura: true, caso: "ACORDO_NOVO", situacaoMannesoft: "ATIVO" });
    expect(r).toEqual({ classe: "EXCECAO", motivo: "COLISAO_CHAVE_NO_LOTE" });
  });

  it("quitação observada é SEMPRE exceção/alerta — nunca automática, mesmo sem nenhum outro conflito", () => {
    const r = avaliarSeguranca({ conflitoNaCaptura: false, caso: "MUDANCA_SITUACAO", situacaoMannesoft: "QUITADO" });
    expect(r.classe).toBe("EXCECAO");
    expect(r.motivo).toBe("QUITACAO_OBSERVADA_EXTERNA");
  });

  it("cancelamento SEM pré-checagem informada cai em exceção (fail-closed) por omissão", () => {
    const r = avaliarSeguranca({ conflitoNaCaptura: false, caso: "MUDANCA_SITUACAO", situacaoMannesoft: "CANCELADO" });
    expect(r.classe).toBe("EXCECAO");
    expect(r.motivo).toBe("CANCELAMENTO_SEM_PRE_CHECAGEM");
  });

  it("cancelamento com pré-checagem explícita (sem parcela paga/baixa) é seguro para automático", () => {
    const r = avaliarSeguranca({
      conflitoNaCaptura: false,
      caso: "MUDANCA_SITUACAO",
      situacaoMannesoft: "CANCELADO",
      semParcelaPagaOuBaixa: true,
    });
    expect(r.classe).toBe("AUTOMATICO");
  });

  it("cancelamento com pré-checagem explicitamente negativa continua exceção", () => {
    const r = avaliarSeguranca({
      conflitoNaCaptura: false,
      caso: "MUDANCA_SITUACAO",
      situacaoMannesoft: "CANCELADO",
      semParcelaPagaOuBaixa: false,
    });
    expect(r.classe).toBe("EXCECAO");
  });

  it("acordo novo sem conflito é seguro para automático", () => {
    const r = avaliarSeguranca({ conflitoNaCaptura: false, caso: "ACORDO_NOVO", situacaoMannesoft: "ATIVO" });
    expect(r.classe).toBe("AUTOMATICO");
  });

  it("reacordo rotulado pelo Mannesoft sempre exige conferência, nunca automático", () => {
    const r = avaliarSeguranca({ conflitoNaCaptura: false, caso: "REACORDO_ROTULADO", situacaoMannesoft: "ATIVO" });
    expect(r.classe).toBe("EXCECAO");
    expect(r.motivo).toBe("REACORDO_EXIGE_CONFERENCIA");
  });

  it("sem mudança nenhuma é seguro para automático (não há nada a promover)", () => {
    const r = avaliarSeguranca({ conflitoNaCaptura: false, caso: "SEM_MUDANCA", situacaoMannesoft: "ATIVO" });
    expect(r.classe).toBe("AUTOMATICO");
  });
});

describe("renegociação sucessiva — acordo cancelado e refeito", () => {
  it("só classifica REACORDO_APOS_CANCELAMENTO com referência explícita AO acordo anterior E o anterior já confirmado CANCELADO", () => {
    const atual = captura({ numeroAcordoMannesoft: "80002", acordoAnteriorMannesoft: "71903" });
    const caso = classificarCaso(null, atual, { situacaoMannesoft: "CANCELADO" });
    expect(caso).toBe("REACORDO_APOS_CANCELAMENTO");
  });

  it("não classifica como reacordo encadeado sem a referência explícita, mesmo que exista um acordo cancelado do mesmo aluno", () => {
    const atual = captura({ numeroAcordoMannesoft: "80003" }); // sem acordoAnteriorMannesoft
    const caso = classificarCaso(null, atual, { situacaoMannesoft: "CANCELADO" });
    expect(caso).toBe("ACORDO_NOVO");
  });

  it("não classifica como reacordo encadeado se o acordo referenciado ainda não está confirmado CANCELADO", () => {
    const atual = captura({ numeroAcordoMannesoft: "80004", acordoAnteriorMannesoft: "71903" });
    const caso = classificarCaso(null, atual, { situacaoMannesoft: "ATIVO" });
    expect(caso).toBe("ACORDO_NOVO");
  });

  it("REACORDO_APOS_CANCELAMENTO sempre exige conferência, nunca automático", () => {
    const r = avaliarSeguranca({ conflitoNaCaptura: false, caso: "REACORDO_APOS_CANCELAMENTO", situacaoMannesoft: "ATIVO" });
    expect(r.classe).toBe("EXCECAO");
    expect(r.motivo).toBe("REACORDO_EXIGE_CONFERENCIA");
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
    const circular = {
      A: { chave: "A", acordoAnteriorChave: "B" },
      B: { chave: "B", acordoAnteriorChave: "A" },
    };
    const cadeia = montarCadeiaReacordo("A", (c) => circular[c] ?? null);
    expect(cadeia).toEqual(["A", "B"]);
  });
});

describe("temComposicaoMista — mensalidades + parcelas de acordo anterior na mesma negociação", () => {
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
      titulos_negociados: [
        { documento: "1", origem: "MENSALIDADE_ORIGINAL" },
        { documento: "2", origem: "MENSALIDADE_ORIGINAL" },
      ],
      titulos_gerados: [],
    };
    expect(temComposicaoMista(composicao)).toBe(false);
  });

  it("origem INDETERMINADA ou ausente nunca conta como mista nem como pura — não inventa distinção que a captura não deu", () => {
    const composicao = {
      titulos_negociados: [{ documento: "1" }, { documento: "2", origem: "INDETERMINADA" }],
      titulos_gerados: [],
    };
    expect(temComposicaoMista(composicao)).toBe(false);
  });

  it("composição mista força exceção mesmo num caso que seria ACORDO_NOVO automático", () => {
    const r = avaliarSeguranca({ conflitoNaCaptura: false, caso: "ACORDO_NOVO", situacaoMannesoft: "ATIVO", composicaoMista: true });
    expect(r.classe).toBe("EXCECAO");
    expect(r.motivo).toBe("COMPOSICAO_MISTA_EXIGE_CONFERENCIA");
  });
});

describe("transformarParaImportarAcordos — proposta, não contrato comprovado", () => {
  it("sempre devolve pendências de validação junto com a linha proposta", () => {
    const r = transformarParaImportarAcordos(captura(), {
      documento: "9000101",
      vencimento: "2026-06-10",
      valor: 500.5,
    });
    expect(r.linhas).toHaveLength(1);
    expect(r.linhas[0].cpf).toBe("05296180011");
    expect(r.pendenciasValidacao.length).toBeGreaterThan(0);
  });
});

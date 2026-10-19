import { describe, expect, it } from "vitest";
import { analisarConfirmacaoF1bNoCRM } from "./analiseFinanceiraF1b";

// Cliente falso: devolve por tabela o que a sessao "veria". A tabela ausente
// representa o que a RLS esconde (o postgREST devolve lista vazia, nao erro).
// `resolver` e o que o envelope confirmacao_pagamentos_resolver_gestao devolveria.
function clienteFake({ gestao = true, tabelas = {}, resolver = null, espiao = [] } = {}) {
  const construir = (nome) => {
    const q = {
      select: () => q,
      eq: () => q,
      in: (coluna, valores) => { espiao.push({ nome, coluna, valores }); return q; },
      order: () => q,
      limit: () => Promise.resolve({ data: tabelas[nome] ?? [], error: null }),
    };
    return q;
  };
  return {
    from: (nome) => { espiao.push({ nome, coluna: null, valores: null }); return construir(nome); },
    rpc: (fn, args) => {
      espiao.push({ nome: `rpc:${fn}`, coluna: null, valores: args ?? null });
      if (fn === "usuario_e_gestao") return Promise.resolve({ data: gestao, error: null });
      if (fn === "confirmacao_pagamentos_resolver_gestao") {
        return Promise.resolve(resolver ?? { data: RESOLVIDO_GRAVADO, error: null });
      }
      return Promise.resolve({ data: null, error: new Error("rpc inesperada") });
    },
    espiao,
  };
}

const RESOLVIDO_GRAVADO = [{ pagamento_id: "g1", prova: "VINCULO_GRAVADO", motivo: null }];
const RESOLVIDO_LEGADO = [{ pagamento_id: "g1", prova: "CHAVE_MESMA_TRANSACAO", motivo: null }];

const TABELAS = {
  solicitacoes_confirmacao_pagamento: [{ id: "c1", aluno_id: "u1", valor_informado: 100 }],
  pagamentos: [{ id: "g1", aluno_id: "u1", cpf: "12345678909", matricula: "2026002333",
                 valor_pago: 100, titulo_numero: "1234", numero_parcela_completo: "789" }],
  alunos: [{ id: "u1", cpf: "12345678909" }],
  prime_contratos: [{ registration: "2026002333", cpf: "12345678909" }],
  acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234" }],
  parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789", status: "PAGO" }],
};

describe("F1.b: leitura no CRM pelo resolver do banco", () => {
  it("recusa antes de ler PII quando a sessao nao e de gestao", async () => {
    const espiao = [];
    const r = await analisarConfirmacaoF1bNoCRM(clienteFake({ gestao: false, tabelas: TABELAS, espiao }), "c1");
    expect(r).toEqual({ situacao: "REVISAO", motivo: "SEM_PERMISSAO_DE_GESTAO" });
    expect(espiao.some(x => x.nome === "prime_contratos")).toBe(false);
    expect(espiao.some(x => x.nome === "rpc:confirmacao_pagamentos_resolver_gestao")).toBe(false);
  });

  it("falha fechada quando o proprio portao nao responde", async () => {
    const cliente = clienteFake({ tabelas: TABELAS });
    cliente.rpc = () => Promise.resolve({ data: null, error: new Error("negado") });
    expect((await analisarConfirmacaoF1bNoCRM(cliente, "c1")).motivo).toBe("LEITURA_INCOMPLETA_OU_NEGADA");
  });

  it("falha fechada quando o envelope do resolver recusa (42501)", async () => {
    const r = await analisarConfirmacaoF1bNoCRM(
      clienteFake({ tabelas: TABELAS, resolver: { data: null, error: new Error("42501") } }), "c1");
    expect(r.motivo).toBe("LEITURA_INCOMPLETA_OU_NEGADA");
  });

  it("usa o resolver em vez de ler a tabela de vinculo direto", async () => {
    const espiao = [];
    await analisarConfirmacaoF1bNoCRM(clienteFake({ tabelas: TABELAS, espiao }), "c1");
    expect(espiao.some(x => x.nome === "rpc:confirmacao_pagamentos_resolver_gestao")).toBe(true);
    expect(espiao.some(x => x.nome === "solicitacao_confirmacao_pagamentos")).toBe(false);
  });

  it("entrega candidato pela rota do vinculo gravado, carregando a prova", async () => {
    const r = await analisarConfirmacaoF1bNoCRM(clienteFake({ tabelas: TABELAS }), "c1");
    expect(r.situacao).toBe("CANDIDATOS_IDENTIFICADOS");
    expect(r.prova_do_conjunto).toBe("VINCULO_GRAVADO");
    expect(r).toMatchObject({ pagamento_confirmado: false, baixa_confirmada: false });
  });

  it("a rota do legado tambem exige prova de CPF pela Prime", async () => {
    const ok = await analisarConfirmacaoF1bNoCRM(
      clienteFake({ tabelas: TABELAS, resolver: { data: RESOLVIDO_LEGADO, error: null } }), "c1");
    expect(ok.situacao).toBe("CANDIDATOS_IDENTIFICADOS");
    expect(ok.prova_do_conjunto).toBe("CHAVE_MESMA_TRANSACAO");
    // sem a ponte Prime, a mesma rota do legado NAO vira candidato
    const semPrime = await analisarConfirmacaoF1bNoCRM(
      clienteFake({ tabelas: { ...TABELAS, prime_contratos: [] },
                    resolver: { data: RESOLVIDO_LEGADO, error: null } }), "c1");
    expect(semPrime.motivo).toBe("IDENTIDADE_NAO_COMPROVADA");
    expect(semPrime.motivo_identidade).toBe("MATRICULA_SEM_REGISTRO_PRIME");
  });

  it("repassa o veredito do resolver quando ele nao resolveu", async () => {
    const semVinculo = await analisarConfirmacaoF1bNoCRM(clienteFake({ tabelas: TABELAS,
      resolver: { data: [{ pagamento_id: null, prova: "SEM_VINCULO",
                           motivo: "nenhum pagamento da mesma transacao/data/nome" }], error: null } }), "c1");
    expect(semVinculo.motivo).toBe("RESOLVER_SEM_VINCULO");
    expect(semVinculo.motivo_resolver).toMatch(/mesma transacao/);
    const ambiguo = await analisarConfirmacaoF1bNoCRM(clienteFake({ tabelas: TABELAS,
      resolver: { data: [{ pagamento_id: null, prova: "AMBIGUO",
                           motivo: "vinculo gravado nao confere: soma 50 x valor 100" }], error: null } }), "c1");
    expect(ambiguo.motivo).toBe("RESOLVER_AMBIGUO");
    expect(ambiguo.motivo_resolver).toMatch(/soma 50/);
  });

  it("conjunto com proveniencias diferentes vai para revisao, sem eleger uma", async () => {
    const tabelas = { ...TABELAS,
      pagamentos: [TABELAS.pagamentos[0], { ...TABELAS.pagamentos[0], id: "g2", valor_pago: 0 }] };
    const r = await analisarConfirmacaoF1bNoCRM(clienteFake({ tabelas,
      resolver: { data: [{ pagamento_id: "g1", prova: "VINCULO_GRAVADO", motivo: null },
                         { pagamento_id: "g2", prova: "CHAVE_MESMA_TRANSACAO", motivo: null }], error: null } }), "c1");
    expect(r.motivo).toBe("PROVAS_MISTURADAS");
    expect(r.provas).toEqual(expect.arrayContaining(["VINCULO_GRAVADO", "CHAVE_MESMA_TRANSACAO"]));
  });

  it("sem nenhuma matricula nao ha ponte Santander -> Prime -> CPF", async () => {
    const tabelas = { ...TABELAS, pagamentos: [{ ...TABELAS.pagamentos[0], matricula: null }] };
    expect((await analisarConfirmacaoF1bNoCRM(clienteFake({ tabelas }), "c1")).motivo).toBe("MATRICULA_AUSENTE");
  });

  it("matricula faltando em PARTE dos pagamentos diz QUAL falhou", async () => {
    const tabelas = { ...TABELAS,
      pagamentos: [TABELAS.pagamentos[0], { ...TABELAS.pagamentos[0], id: "g2", matricula: null }] };
    const r = await analisarConfirmacaoF1bNoCRM(clienteFake({ tabelas,
      resolver: { data: [{ pagamento_id: "g1", prova: "VINCULO_GRAVADO", motivo: null },
                         { pagamento_id: "g2", prova: "VINCULO_GRAVADO", motivo: null }], error: null } }), "c1");
    expect(r.situacao).toBe("REVISAO");
    expect(r.motivo_identidade).toBe("CHAVE_DE_IDENTIDADE_AUSENTE");
  });

  it("o pre-filtro envia a forma canonica junto com a gravada", async () => {
    const espiao = [];
    const tabelas = { ...TABELAS,
      pagamentos: [{ ...TABELAS.pagamentos[0], titulo_numero: "01234", numero_parcela_completo: "0789" }] };
    await analisarConfirmacaoF1bNoCRM(clienteFake({ tabelas, espiao }), "c1");
    expect(espiao.find(x => x.nome === "acordos" && x.coluna === "numero_ulbra").valores)
      .toEqual(expect.arrayContaining(["01234", "1234"]));
    expect(espiao.find(x => x.nome === "parcelas" && x.coluna === "boleto").valores)
      .toEqual(expect.arrayContaining(["0789", "789"]));
  });

  it("confirmacao fora do alcance da sessao nao vira candidato", async () => {
    const r = await analisarConfirmacaoF1bNoCRM(
      clienteFake({ tabelas: { ...TABELAS, solicitacoes_confirmacao_pagamento: [] } }), "c1");
    expect(r.motivo).toBe("CONFIRMACAO_INACESSIVEL");
  });
});

import { describe, expect, it } from "vitest";
import { analisarConfirmacaoF1bNoCRM } from "./analiseFinanceiraF1b";

// Cliente falso: devolve por tabela o que a sessao "veria". A tabela ausente
// representa o que a RLS esconde (o postgREST devolve lista vazia, nao erro).
function clienteFake({ gestao = true, tabelas = {}, espiao = [] } = {}) {
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
    from: (nome) => construir(nome),
    rpc: (fn) => Promise.resolve(fn === "usuario_e_gestao"
      ? { data: gestao, error: null }
      : { data: null, error: new Error("rpc inesperada") }),
    espiao,
  };
}

const TABELAS = {
  solicitacoes_confirmacao_pagamento: [{ id: "c1", aluno_id: "u1", valor_informado: 100 }],
  solicitacao_confirmacao_pagamentos: [{ confirmacao_id: "c1", pagamento_id: "g1" }],
  pagamentos: [{ id: "g1", aluno_id: "u1", cpf: "12345678909", matricula: "2026002333",
                 valor_pago: 100, titulo_numero: "1234", numero_parcela_completo: "789" }],
  alunos: [{ id: "u1", cpf: "12345678909" }],
  prime_contratos: [{ registration: "2026002333", cpf: "12345678909" }],
  acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234" }],
  parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789" }],
};

describe("F1.b: leitura no CRM", () => {
  it("recusa antes de ler PII quando a sessao nao e de gestao", async () => {
    const espiao = [];
    const r = await analisarConfirmacaoF1bNoCRM(clienteFake({ gestao: false, tabelas: TABELAS, espiao }), "c1");
    expect(r).toEqual({ situacao: "REVISAO", motivo: "SEM_PERMISSAO_DE_GESTAO" });
    // o portao vale por si: nenhuma consulta a prime_contratos chegou a ser montada
    expect(espiao.some(x => x.nome === "prime_contratos")).toBe(false);
  });

  it("falha fechada quando o proprio portao nao responde", async () => {
    const cliente = clienteFake({ tabelas: TABELAS });
    cliente.rpc = () => Promise.resolve({ data: null, error: new Error("negado") });
    const r = await analisarConfirmacaoF1bNoCRM(cliente, "c1");
    expect(r.motivo).toBe("LEITURA_INCOMPLETA_OU_NEGADA");
  });

  it("entrega candidato quando gestao ve todas as fontes", async () => {
    const r = await analisarConfirmacaoF1bNoCRM(clienteFake({ tabelas: TABELAS }), "c1");
    expect(r.situacao).toBe("CANDIDATOS_IDENTIFICADOS");
    expect(r).toMatchObject({ pagamento_confirmado: false, baixa_confirmada: false });
  });

  it("sem nenhuma matricula nao ha ponte Santander -> Prime -> CPF", async () => {
    const tabelas = { ...TABELAS, pagamentos: [{ ...TABELAS.pagamentos[0], matricula: null }] };
    const r = await analisarConfirmacaoF1bNoCRM(clienteFake({ tabelas }), "c1");
    expect(r.motivo).toBe("MATRICULA_AUSENTE");
  });

  it("matricula faltando em PARTE dos pagamentos nao descarta o conjunto sem dizer qual falhou", async () => {
    const tabelas = {
      ...TABELAS,
      solicitacao_confirmacao_pagamentos: [
        { confirmacao_id: "c1", pagamento_id: "g1" }, { confirmacao_id: "c1", pagamento_id: "g2" }],
      pagamentos: [TABELAS.pagamentos[0], { ...TABELAS.pagamentos[0], id: "g2", matricula: null }],
    };
    const r = await analisarConfirmacaoF1bNoCRM(clienteFake({ tabelas }), "c1");
    expect(r.situacao).toBe("REVISAO");
    expect(r.motivo_identidade).toBe("CHAVE_DE_IDENTIDADE_AUSENTE");
  });

  it("o pre-filtro envia a forma canonica junto com a gravada", async () => {
    const espiao = [];
    const tabelas = { ...TABELAS,
      pagamentos: [{ ...TABELAS.pagamentos[0], titulo_numero: "01234", numero_parcela_completo: "0789" }] };
    await analisarConfirmacaoF1bNoCRM(clienteFake({ tabelas, espiao }), "c1");
    const numeros = espiao.find(x => x.nome === "acordos" && x.coluna === "numero_ulbra");
    const boletos = espiao.find(x => x.nome === "parcelas" && x.coluna === "boleto");
    expect(numeros.valores).toEqual(expect.arrayContaining(["01234", "1234"]));
    expect(boletos.valores).toEqual(expect.arrayContaining(["0789", "789"]));
  });

  it("confirmacao fora do alcance da sessao nao vira candidato", async () => {
    const r = await analisarConfirmacaoF1bNoCRM(
      clienteFake({ tabelas: { ...TABELAS, solicitacoes_confirmacao_pagamento: [] } }), "c1");
    expect(r.motivo).toBe("CONFIRMACAO_INACESSIVEL");
  });

  it("sem vinculo gravado nao cai para nome, data ou valor", async () => {
    const r = await analisarConfirmacaoF1bNoCRM(
      clienteFake({ tabelas: { ...TABELAS, solicitacao_confirmacao_pagamentos: [] } }), "c1");
    expect(r.motivo).toBe("SEM_VINCULO_GRAVADO");
  });
});

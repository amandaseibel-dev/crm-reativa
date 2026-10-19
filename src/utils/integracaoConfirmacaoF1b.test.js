import { describe, expect, it } from "vitest";
import { analisarConfirmacaoF1b as analisar } from "./integracaoConfirmacaoF1b";

const confirmacao = { id: "c1", aluno_id: "u1", valor_informado: 100 };
const vinculosGravados = [{ confirmacao_id: "c1", pagamento_id: "g1" }];
const pagamentos = [{ id: "g1", aluno_id: "u1", valor_pago: 100, titulo_numero: "1234", numero_parcela_completo: "789" }];
const acordos = [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234" }];
const parcelas = [{ id: "p1", acordo_id: "a1", boleto: "789" }];
const alunos = [{ id: "u1", cpf: "12345678909" }];
const primeContratos = [{ registration: "2026002333", cpf: "12345678909" }];
const base = { confirmacao, vinculosGravados, pagamentos: pagamentos.map(p => ({ ...p, matricula: "2026002333" })), acordos, parcelas, alunos, primeContratos };

describe("F1.b adaptador somente leitura para vínculo gravado", () => {
  it("aluno ligado apenas pelo nome nao e prova suficiente", () => {
    expect(analisar({ ...base, primeContratos: [] }).motivo).toBe("IDENTIDADE_NAO_COMPROVADA");
    expect(analisar({ ...base, alunos: [] }).motivo).toBe("IDENTIDADE_NAO_COMPROVADA");
  });
  it("aceita somente conjunto gravado e coerente", () => {
    const r = analisar(base);
    expect(r.situacao).toBe("CANDIDATOS_IDENTIFICADOS");
    expect(r.resultados).toHaveLength(1);
    expect(r).toMatchObject({ baixa_confirmada: false, pagamento_confirmado: false });
  });
  it("sem relação gravada não infere pelo nome ou data", () => {
    expect(analisar({ ...base, vinculosGravados: [] }).motivo).toBe("SEM_VINCULO_GRAVADO");
  });
  it("identidade divergente interrompe todo o conjunto", () => {
    expect(analisar({ ...base, pagamentos: [{ ...pagamentos[0], aluno_id: "u2" }] }).motivo).toBe("IDENTIDADE_DIVERGENTE");
  });
  it("vínculo repetido não conta pagamento duas vezes", () => {
    expect(analisar({ ...base, vinculosGravados: [...vinculosGravados, ...vinculosGravados] }).motivo).toBe("RELACAO_DE_PAGAMENTOS_INVALIDA");
  });
  it("sem todas as linhas falha fechado", () => {
    expect(analisar({ ...base, pagamentos: [] }).motivo).toBe("PAGAMENTO_AUSENTE_OU_DUPLICADO");
  });
  it("valor divergente não identifica o conjunto como seguro", () => {
    expect(analisar({ ...base, confirmacao: { ...confirmacao, valor_informado: 200 } }).motivo).toBe("VALORES_NAO_CONFEREM");
  });
  it("identificador ambíguo remete o conjunto para revisão", () => {
    const r = analisar({ ...base, acordos: [...acordos, { ...acordos[0], id: "a2" }] });
    expect(r).toMatchObject({ situacao: "REVISAO", motivo: "CONJUNTO_COM_EXCECAO" });
  });
  it("duas linhas com valor correto exigem ambas identificadas", () => {
    const r = analisar({ ...base,
      vinculosGravados: [...vinculosGravados, { confirmacao_id: "c1", pagamento_id: "g2" }],
      pagamentos: [...pagamentos, { id: "g2", aluno_id: "u1", valor_pago: 20, titulo_numero: "9999" }],
      confirmacao: { ...confirmacao, valor_informado: 120 },
    });
    expect(r.motivo).toBe("CONJUNTO_COM_EXCECAO");
  });
});

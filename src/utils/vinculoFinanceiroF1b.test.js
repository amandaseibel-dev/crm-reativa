import { describe, expect, it } from "vitest";
import { identificarVinculoF1b as identificar } from "./vinculoFinanceiroF1b";

const acordo = { id: "a1", aluno_id: "u1", numero_ulbra: "001234" };
const parcela = { id: "p1", acordo_id: "a1", boleto: "000789" };
const pg = { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "789" };
describe("F1.b: somente candidatos determinísticos, sem baixa", () => {
  it("identifica acordo e parcela com chaves exatas", () => {
    expect(identificar({ pagamento: pg, acordos: [acordo], parcelas: [parcela] })).toEqual({
      situacao: "CANDIDATO_DETERMINISTICO", motivo: "IDENTIFICADOR_EXATO_E_ALUNO_CONFERIDO",
      aluno_id: "u1", acordo_id: "a1", parcela_id: "p1",
      pagamento_confirmado: false, baixa_confirmada: false,
    });
  });
  it("sem aluno nunca decide", () => {
    expect(identificar({ pagamento: { ...pg, aluno_id: null }, acordos: [acordo], parcelas: [parcela] }).situacao).toBe("REVISAO");
  });
  it("homônimo ou nome não serve para vincular", () => {
    expect(identificar({ pagamento: { aluno_nome: "Pessoa Teste" }, acordos: [acordo] }).situacao).toBe("REVISAO");
  });
  it("identificador inexistente não usa data/valor como fallback", () => {
    expect(identificar({ pagamento: { ...pg, titulo_numero: "999" }, acordos: [acordo], parcelas: [parcela] }).motivo).toBe("ACORDO_NAO_ENCONTRADO");
  });
  it("duplicidade de acordo é ambígua", () => {
    expect(identificar({ pagamento: pg, acordos: [acordo, { ...acordo, id: "a2" }], parcelas: [parcela] }).motivo).toBe("ACORDO_AMBIGUO");
  });
  it("acordo de aluno diferente não é vínculo", () => {
    expect(identificar({ pagamento: pg, acordos: [{ ...acordo, aluno_id: "u2" }], parcelas: [parcela] }).motivo).toBe("IDENTIDADE_DIVERGENTE");
  });
  it("parcela de outro acordo/aluno não é aceita", () => {
    expect(identificar({ pagamento: pg, acordos: [acordo], parcelas: [{ ...parcela, acordo_id: "outro" }] }).motivo).toBe("PARCELA_FORA_DO_ALUNO");
  });
  it("identificadores contraditórios bloqueiam", () => {
    const outros = [{ ...acordo }, { id: "a2", aluno_id: "u1", numero_ulbra: "7654" }];
    expect(identificar({ pagamento: pg, acordos: outros, parcelas: [{ ...parcela, acordo_id: "a2" }] }).motivo).toBe("IDENTIFICADORES_CONTRADITORIOS");
  });
  it("boleto duplicado bloqueia", () => {
    expect(identificar({ pagamento: pg, acordos: [acordo], parcelas: [parcela, { ...parcela, id: "p2" }] }).motivo).toBe("BOLETO_AMBIGUO");
  });
  it("nao transforma letras de identificador invalido em correspondencia", () => {
    const r = identificar({ pagamento: { ...pg, titulo_numero: "XXX1234" }, acordos: [acordo], parcelas: [parcela] });
    expect(r.situacao).toBe("REVISAO");
  });
  it("vínculo por número do acordo sem boleto não confirma parcela", () => {
    const r = identificar({ pagamento: { aluno_id: "u1", titulo_numero: "1234" }, acordos: [acordo] });
    expect(r).toMatchObject({ situacao: "CANDIDATO_DETERMINISTICO", acordo_id: "a1", parcela_id: null, baixa_confirmada: false });
  });
});

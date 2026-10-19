import { describe, expect, it } from "vitest";
import { identificarVinculoF1b as identificar } from "./vinculoFinanceiroF1b";

const acordo = { id: "a1", aluno_id: "u1", numero_ulbra: "001234", status: "ATIVO" };
const parcela = { id: "p1", acordo_id: "a1", boleto: "000789", status: "PAGO" };
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
    const outros = [{ ...acordo }, { id: "a2", aluno_id: "u1", numero_ulbra: "7654", status: "ATIVO" }];
    expect(identificar({ pagamento: pg, acordos: outros, parcelas: [{ ...parcela, acordo_id: "a2" }] }).motivo).toBe("IDENTIFICADORES_CONTRADITORIOS");
  });
  it("boleto duplicado bloqueia", () => {
    expect(identificar({ pagamento: pg, acordos: [acordo], parcelas: [parcela, { ...parcela, id: "p2" }] }).motivo).toBe("BOLETO_AMBIGUO");
  });
  it("nao transforma letras de identificador invalido em correspondencia", () => {
    const r = identificar({ pagamento: { ...pg, titulo_numero: "XXX1234" }, acordos: [acordo], parcelas: [parcela] });
    expect(r).toMatchObject({ situacao: "REVISAO", motivo: "IDENTIFICADOR_INVALIDO" });
  });
  it("vínculo por número do acordo sem boleto não confirma parcela", () => {
    const r = identificar({ pagamento: { aluno_id: "u1", titulo_numero: "1234" }, acordos: [acordo] });
    expect(r).toMatchObject({ situacao: "CANDIDATO_DETERMINISTICO", acordo_id: "a1", parcela_id: null, baixa_confirmada: false });
  });

  it("status nao carregado reprova com motivo PROPRIO, para o select ser diagnosticavel", () => {
    for (const parcelaSemStatus of [{ id: "p1", acordo_id: "a1", boleto: "789" },
                                    { id: "p1", acordo_id: "a1", boleto: "789", status: null },
                                    { id: "p1", acordo_id: "a1", boleto: "789", status: "  " }]) {
      const r = identificar({
        pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "789" },
        acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status: "ATIVO" }],
        parcelas: [parcelaSemStatus],
      });
      expect(r.situacao).toBe("REVISAO");
      expect(r.motivo).toBe("PARCELA_SEM_STATUS");
      expect(r).toMatchObject({ acordo_id: "a1", parcela_id: "p1" });
    }
  });

  it("parcela fora de cobranca nao vira candidato, mesmo com identificador exato", () => {
    for (const status of ["CANCELADA", "SUSPENSA", "RENEGOCIADA", "ESTADO_NOVO_QUALQUER"]) {
      const r = identificar({
        pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "789" },
        acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status: "ATIVO" }],
        parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789", status }],
      });
      expect(r.situacao).toBe("REVISAO");
      expect(r.motivo).toBe("PARCELA_FORA_DE_COBRANCA");
      expect(r.status_parcela).toBe(status);
      // ainda diz ONDE olhar, senao a revisao nao tem por onde comecar
      expect(r).toMatchObject({ acordo_id: "a1", parcela_id: "p1" });
    }
  });

  it("os tres status em cobranca seguem virando candidato", () => {
    for (const status of ["PAGO", "A_VENCER", "VENCIDA", "vencida", " pago "]) {
      const r = identificar({
        pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "789" },
        acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status: "ATIVO" }],
        parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789", status }],
      });
      expect(r.situacao).toBe("CANDIDATO_DETERMINISTICO");
      expect(r).toMatchObject({ pagamento_confirmado: false, baixa_confirmada: false });
    }
  });

  it("sem boleto o candidato e de ACORDO e nao ha status de parcela a conferir", () => {
    const r = identificar({
      pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: null },
      acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status: "ATIVO" }],
      parcelas: [],
    });
    expect(r.situacao).toBe("CANDIDATO_DETERMINISTICO");
    expect(r.parcela_id).toBeNull();
  });

  // ---- portao de status do ACORDO ------------------------------------------
  // O portao da parcela nao alcanca este caso: a parcela pode estar num status da
  // allowlist DENTRO de acordo cancelado. Medido em 19/10/2026: 0 na fila aberta,
  // 13 no universo todo (12 em parcela PAGO, 1 em VENCIDA, ambas em acordo
  // CANCELADO). Latente, nao ativo -- fechado antes de aparecer na fila.
  it("acordo CANCELADO nao vira candidato nem com parcela em status valido", () => {
    for (const statusParcela of ["PAGO", "A_VENCER", "VENCIDA"]) {
      const r = identificar({
        pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "789" },
        acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status: "CANCELADO" }],
        parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789", status: statusParcela }],
      });
      expect(r.situacao, statusParcela).toBe("REVISAO");
      expect(r.motivo, statusParcela).toBe("ACORDO_FORA_DE_COBRANCA");
      expect(r.status_acordo, statusParcela).toBe("CANCELADO");
      expect(r.acordo_id, statusParcela).toBe("a1");
      expect(r.parcela_id, statusParcela).toBe("p1");
    }
  });

  it("acordo QUITADO segue destino legitimo de pagamento", () => {
    const r = identificar({
      pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "789" },
      acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status: "QUITADO" }],
      parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789", status: "PAGO" }],
    });
    expect(r.situacao).toBe("CANDIDATO_DETERMINISTICO");
  });

  it("status do acordo nao carregado reprova com motivo proprio, nao como cancelado", () => {
    for (const status of [undefined, null, "", "   "]) {
      const r = identificar({
        pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "789" },
        acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status }],
        parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789", status: "PAGO" }],
      });
      expect(r.motivo).toBe("ACORDO_SEM_STATUS");
    }
  });

  it("ALLOWLIST do acordo: status novo no catalogo cai em revisao, nao em candidato", () => {
    const r = identificar({
      pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "789" },
      acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status: "SUSPENSO_NOVO" }],
      parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789", status: "PAGO" }],
    });
    expect(r.motivo).toBe("ACORDO_FORA_DE_COBRANCA");
  });

  it("o acordo e conferido ANTES da parcela: com os dois ruins, o motivo e do acordo", () => {
    const r = identificar({
      pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "789" },
      acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status: "CANCELADO" }],
      parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789", status: "CANCELADA" }],
    });
    expect(r.motivo).toBe("ACORDO_FORA_DE_COBRANCA");
  });

  it("acordo sem boleto tambem passa pelo portao de status", () => {
    const r = identificar({
      pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "" },
      acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status: "CANCELADO" }],
      parcelas: [],
    });
    expect(r.motivo).toBe("ACORDO_FORA_DE_COBRANCA");
    expect(r.parcela_id).toBeNull();
  });

  // ---- invariantes que a gestao pediu por escrito ---------------------------
  it("REGRA: candidato nunca sai como pagamento confirmado ou baixa autorizada", () => {
    const r = identificar({
      pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "789" },
      acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status: "ATIVO" }],
      parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789", status: "VENCIDA" }],
    });
    expect(r.situacao).toBe("CANDIDATO_DETERMINISTICO");
    expect(r).toMatchObject({ pagamento_confirmado: false, baixa_confirmada: false });
  });

  it("REGRA: ambiguidade e divergencia ficam em revisao, qualquer que seja o status", () => {
    const ambiguo = identificar({
      pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "789" },
      acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status: "ATIVO" },
                { id: "a2", aluno_id: "u1", numero_ulbra: "01234", status: "ATIVO" }],
      parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789", status: "VENCIDA" }],
    });
    expect(ambiguo.situacao).toBe("REVISAO");
    expect(ambiguo.motivo).toBe("ACORDO_AMBIGUO");

    const deOutroAluno = identificar({
      pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "789" },
      acordos: [{ id: "a1", aluno_id: "OUTRO", numero_ulbra: "1234", status: "ATIVO" }],
      parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789", status: "VENCIDA" }],
    });
    expect(deOutroAluno.situacao).toBe("REVISAO");
    expect(deOutroAluno.motivo).toBe("IDENTIDADE_DIVERGENTE");
  });

  it("REGRA: nenhum retorno do motor carrega instrucao de baixa ou quitacao", () => {
    const entradas = [
      { acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status: "ATIVO" }],
        parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789", status: "VENCIDA" }] },
      { acordos: [{ id: "a1", aluno_id: "u1", numero_ulbra: "1234", status: "CANCELADO" }],
        parcelas: [{ id: "p1", acordo_id: "a1", boleto: "789", status: "CANCELADA" }] },
    ];
    for (const e of entradas) {
      const r = identificar({
        pagamento: { aluno_id: "u1", titulo_numero: "1234", numero_parcela_completo: "789" }, ...e });
      const chaves = Object.keys(r);
      expect(chaves.some(k => /baixar|quitar|aplicar|executar|confirmar/i.test(k))).toBe(false);
      expect(r.pagamento_confirmado ?? false).toBe(false);
      expect(r.baixa_confirmada ?? false).toBe(false);
    }
  });
});

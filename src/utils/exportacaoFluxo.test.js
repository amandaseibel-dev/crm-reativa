import { describe, it, expect } from "vitest";
import { bloqueiaNovaExportacao, mensagemDaFase, FASE } from "./exportacaoFluxo.js";

describe("bloqueio de interface", () => {
  it("so o resultado incerto bloqueia nova exportacao", () => {
    expect(bloqueiaNovaExportacao(FASE.INCERTA)).toBe(true);
    for (const f of [FASE.OCIOSO, FASE.CONCLUIDA, FASE.ARQUIVO_FALHOU, FASE.RECUSADA]) {
      expect(bloqueiaNovaExportacao(f)).toBe(false);
    }
  });
});

describe("mensagens por fase", () => {
  it("separa 'lote registrado, arquivo nao baixado' de 'resultado desconhecido'", () => {
    expect(mensagemDaFase(FASE.ARQUIVO_FALHOU)).toMatch(/Lote registrado, arquivo não baixado/);
    expect(mensagemDaFase(FASE.INCERTA)).toMatch(/Resultado do registro desconhecido/);
    expect(mensagemDaFase(FASE.ARQUIVO_FALHOU)).not.toMatch(/desconhecido/);
  });

  it("nenhuma mensagem contem dado pessoal ficticio", () => {
    for (const f of Object.values(FASE)) {
      expect(mensagemDaFase(f)).not.toMatch(/Fictício|@|5100000001/);
    }
  });
});

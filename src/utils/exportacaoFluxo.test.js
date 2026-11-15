import { describe, it, expect } from "vitest";
import { bloqueiaNovaExportacao, mensagemDaFase, FASE } from "./exportacaoFluxo.js";

describe("bloqueio de interface", () => {
  it("resultado incerto e lote sem arquivo bloqueiam nova exportacao", () => {
    expect(bloqueiaNovaExportacao(FASE.INCERTA)).toBe(true);
    expect(bloqueiaNovaExportacao(FASE.ARQUIVO_FALHOU)).toBe(true);
  });

  it("ocioso, concluida e recusada nao bloqueiam", () => {
    for (const f of [FASE.OCIOSO, FASE.CONCLUIDA, FASE.RECUSADA]) {
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

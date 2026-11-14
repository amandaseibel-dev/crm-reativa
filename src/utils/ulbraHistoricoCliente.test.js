import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { mapearHistorico, MOTIVOS_HISTORICO } from "./ulbraHistoricoCliente";

describe("cliente de historico", () => {
  it("mapeia pagina ok", () => {
    const r = mapearHistorico({ ok: true, pagina: { mensagens: [{ texto: "a" }], antes_de: null } });
    expect(r.estado).toBe("ok");
    expect(r.mensagens).toHaveLength(1);
  });
  it("erro conhecido vira mensagem", () => {
    const r = mapearHistorico({ ok: false, motivo: "SEM_PERMISSAO_NA_CONVERSA" });
    expect(r.estado).toBe("erro");
    expect(r.erro).toBe(MOTIVOS_HISTORICO.SEM_PERMISSAO_NA_CONVERSA);
  });
  it("modulo nao contem rota de conexao, previa ou envio", () => {
    const src = fs.readFileSync(new URL("./ulbraHistoricoCliente.js", import.meta.url), "utf8");
    for (const termo of ["conexao_", "envio_", "envioPrevia", "envioConfirmar", "conexaoIniciar", "oauth"]) {
      expect(src.includes(termo)).toBe(false);
    }
  });
});

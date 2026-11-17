import { describe, it, expect } from "vitest";
import { decidirResposta, type EntradaResposta } from "./autorizacao-resposta.ts";

const EU = "cobranca10@aelbra.com.br";
const BASE: EntradaResposta = {
  envioReal: true,
  conexaoOk: true,
  pessoaConexao: EU,
  email: EU,
  espelhada: true,
  atendimentoAtivoId: "a".repeat(24),
  responsavelAtivo: EU,
};

describe("autorização de resposta por conversa", () => {
  it("responsável comprovado, conexão e identidade ok, envio habilitado: pode", () => {
    expect(decidirResposta(BASE)).toEqual({ pode: true, motivo: null });
  });

  it("envioReal=true sozinho não basta: sem ser o responsável do atendimento, não pode", () => {
    expect(decidirResposta({ ...BASE, responsavelAtivo: "cobranca07@aelbra.com.br" })).toEqual({ pode: false, motivo: "ATENDIMENTO_NAO_RESPONSAVEL" });
  });

  it("atendimento sem responsável comprovado: não pode", () => {
    expect(decidirResposta({ ...BASE, responsavelAtivo: null }).motivo).toBe("ATENDIMENTO_NAO_RESPONSAVEL");
  });

  it("envio desligado no servidor: ENVIO_DESATIVADO, mesmo sendo o responsável", () => {
    expect(decidirResposta({ ...BASE, envioReal: false })).toEqual({ pode: false, motivo: "ENVIO_DESATIVADO" });
  });

  it("sem conexão individual ativa: SEM_CONEXAO", () => {
    expect(decidirResposta({ ...BASE, conexaoOk: false }).motivo).toBe("SEM_CONEXAO");
  });

  it("conta conectada diferente do usuário: IDENTIDADE_DIVERGENTE", () => {
    expect(decidirResposta({ ...BASE, pessoaConexao: "outra@aelbra.com.br" }).motivo).toBe("IDENTIDADE_DIVERGENTE");
  });

  it("conversa não espelhada ou sem atendimento ativo: bloqueia", () => {
    expect(decidirResposta({ ...BASE, espelhada: false }).motivo).toBe("CONVERSA_NAO_ESPELHADA");
    expect(decidirResposta({ ...BASE, atendimentoAtivoId: null }).motivo).toBe("SEM_ATENDIMENTO_ATIVO");
  });

  it("comparação de e-mail sem diferenciar maiúsculas", () => {
    expect(decidirResposta({ ...BASE, responsavelAtivo: EU.toUpperCase() }).pode).toBe(true);
  });

  it("ordem dos bloqueios: envio desligado vence os demais", () => {
    expect(decidirResposta({ ...BASE, envioReal: false, conexaoOk: false, responsavelAtivo: null }).motivo).toBe("ENVIO_DESATIVADO");
  });
});

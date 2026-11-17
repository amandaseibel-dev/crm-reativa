import { describe, it, expect } from "vitest";
import { configuracaoFaltando, precisaOauth } from "./configuracao-acao.ts";

const PILOTO = { clientId: undefined, redirectUri: undefined, chave: "chave-hex" };
const COMPLETA = { clientId: "c", redirectUri: "https://x/ulbra/conectado", chave: "chave-hex" };

describe("piloto: OAuth indisponível por configuração", () => {
  it("sem client_id/redirect_uri: conexao_iniciar e conexao_concluir são recusadas (503), antes de qualquer troca", () => {
    expect(configuracaoFaltando("conexao_iniciar", PILOTO)).toBe(true);
    expect(configuracaoFaltando("conexao_concluir", PILOTO)).toBe(true);
  });
  it("com a configuração OAuth presente, o fluxo OAuth fica liberado (não é o piloto)", () => {
    expect(configuracaoFaltando("conexao_concluir", COMPLETA)).toBe(false);
  });
  it("token pessoal e histórico NÃO dependem de OAuth: com só a chave, liberados", () => {
    expect(configuracaoFaltando("conexao_token_pessoal", PILOTO)).toBe(false);
    expect(configuracaoFaltando("historico_ler", PILOTO)).toBe(false);
    expect(configuracaoFaltando("envio_confirmar", PILOTO)).toBe(false);
  });
  it("sem chave de cifra, qualquer ação que usa conexão é recusada", () => {
    expect(configuracaoFaltando("conexao_token_pessoal", { ...PILOTO, chave: undefined })).toBe(true);
  });
  it("só conexao_iniciar e conexao_concluir são ações OAuth", () => {
    expect(precisaOauth("conexao_iniciar")).toBe(true);
    expect(precisaOauth("conexao_concluir")).toBe(true);
    expect(precisaOauth("conexao_token_pessoal")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { podeVerTudo } from "./operadores";

// podeVerTudo passou a aceitar um 2º argumento (perfil) por causa do perfil
// "diretoria", que vê o Panorama 360 consolidado. Estes testes travam as duas
// pontas: a diretoria passa a ver tudo, e quem chama só com o e-mail (a maior
// parte das telas) continua exatamente como antes.
describe("podeVerTudo", () => {
  const GESTAO = [
    "amanda.seibel@aelbra.com.br",
    "cobranca04@aelbra.com.br",
    "cobranca07@aelbra.com.br",
  ];

  it("mantém a allowlist de gestão quando só o e-mail é passado", () => {
    GESTAO.forEach((e) => expect(podeVerTudo(e)).toBe(true));
  });

  it("continua negando operador que chama sem perfil", () => {
    expect(podeVerTudo("cobranca05@aelbra.com.br")).toBe(false);
    expect(podeVerTudo("")).toBe(false);
    expect(podeVerTudo(null)).toBe(false);
    expect(podeVerTudo(undefined)).toBe(false);
  });

  it("libera o perfil diretoria, mesmo com e-mail fora da allowlist", () => {
    expect(podeVerTudo("diretoria@aelbra.com.br", "diretoria")).toBe(true);
  });

  it("não libera outros perfis fora da allowlist", () => {
    ["operador", "supervisor", "administrativo", "auditor", "gerencia"].forEach((p) =>
      expect(podeVerTudo("cobranca05@aelbra.com.br", p)).toBe(false)
    );
  });

  it("não se confunde com espaço/caixa no perfil", () => {
    expect(podeVerTudo("x@aelbra.com.br", " Diretoria ")).toBe(true);
    expect(podeVerTudo("x@aelbra.com.br", "diretoriax")).toBe(false);
  });

  it("gestão segue vendo tudo mesmo com perfil informado", () => {
    expect(podeVerTudo("amanda.seibel@aelbra.com.br", "gerencia")).toBe(true);
  });
});

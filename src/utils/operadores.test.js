import { describe, it, expect } from "vitest";
import { podeVerTudo, emailPorNomeOperador } from "./operadores";

// As planilhas (Santander/Prime) trazem o operador como login
// "NOME.SOBRENOME". A resolução tenta o login completo (aliases como
// AMANDA.BORGES) antes de cair para o primeiro nome — cortar direto no
// ponto deixava a Amanda ADM sem operador_email e fora do ranking.
describe("emailPorNomeOperador", () => {
  it("resolve login completo com alias (Amanda Borges -> Amanda ADM)", () => {
    expect(emailPorNomeOperador("AMANDA.BORGES")).toBe("cobranca07@aelbra.com.br");
    expect(emailPorNomeOperador("amanda.borges")).toBe("cobranca07@aelbra.com.br");
  });

  it("cai para o primeiro nome quando o login completo não casa", () => {
    expect(emailPorNomeOperador("ALLAN.SILVA")).toBe("cobranca11@aelbra.com.br");
    expect(emailPorNomeOperador("OLGA.OLIVEIRA")).toBe("cobranca03@aelbra.com.br");
    expect(emailPorNomeOperador("MAURICIO.FEIJO")).toBe("cobranca06@aelbra.com.br");
  });

  it("mantém quem não é da equipe sem e-mail", () => {
    expect(emailPorNomeOperador("ADEMIR.SANTOS")).toBe(null);
    // AMANDA sozinho é ambíguo (ADM x gestora) — segue sem casar até
    // decisão explícita sobre AMANDA.SEIBEL.
    expect(emailPorNomeOperador("AMANDA.SEIBEL")).toBe(null);
    expect(emailPorNomeOperador("")).toBe(null);
  });

  it("segue casando nomes simples e variações já tratadas", () => {
    expect(emailPorNomeOperador("Rafaela")).toBe("cobranca12@aelbra.com.br");
    expect(emailPorNomeOperador("NATALY")).toBe("cobranca08@aelbra.com.br");
    expect(emailPorNomeOperador("MAURICIO")).toBe("cobranca06@aelbra.com.br");
  });
});

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

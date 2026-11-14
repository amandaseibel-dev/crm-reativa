import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EMAILS_PREVENTIVO, podeVerPreventivo } from "./acessoPreventivo";

// ACESSO À TELA DO PREVENTIVO: Amanda (gerência) + Angela e Gustavo (diretoria).
// O portão de verdade é do banco (`preventivo_e_gestao()`); a tela só espelha.
// Estes testes travam três coisas: a lista é a MESMA do banco, nenhum outro
// perfil entra, e a rota não foi aberta à diretoria em geral.
const AQUI = dirname(fileURLToPath(import.meta.url));
const App = readFileSync(resolve(AQUI, "..", "App.jsx"), "utf8");
const migracao = readFileSync(
  resolve(AQUI, "..", "..", "supabase", "migrations",
    "20261112130000_preventivo_gestao_exige_papel_no_jwt_sem_email.sql"), "utf8");

describe("podeVerPreventivo", () => {
  it("libera os três e-mails do portão do banco, sem diferenciar caixa nem espaços", () => {
    for (const e of EMAILS_PREVENTIVO) expect(podeVerPreventivo(e)).toBe(true);
    expect(podeVerPreventivo("  Angela.Ferreira@AELBRA.com.br ")).toBe(true);
    expect(podeVerPreventivo("GUSTAVO.ENE@aelbra.com.br")).toBe(true);
  });

  it("barra gestão que não é do Preventivo, operadores, vazio e e-mails parecidos", () => {
    for (const e of [
      "cobranca07@aelbra.com.br", // Amanda ADM
      "cobranca04@aelbra.com.br", // Fernanda
      "cobranca01@aelbra.com.br",
      "ninguem@exemplo.com",
      "amanda.seibel@aelbra.com.br.evil.com",
      "xamanda.seibel@aelbra.com.br",
      "", "   ", null, undefined, 0,
    ]) expect(podeVerPreventivo(e)).toBe(false);
  });

  it("a lista da tela é exatamente a do portão do banco (migration 130000)", () => {
    const corpo = migracao.slice(migracao.indexOf("return em in ("));
    const doBanco = [...corpo.matchAll(/'([^']+@aelbra\.com\.br)'/g)].map((m) => m[1]).sort();
    expect(doBanco.length).toBe(3);
    expect([...EMAILS_PREVENTIVO].sort()).toEqual(doBanco);
  });
});

describe("App.jsx — rota e menu passam por podeVerPreventivo", () => {
  it("a rota decide pela pessoa, ANTES do gate por perfil, e recusa operador", () => {
    const i = App.indexOf('if (rota === "/preventivo") {');
    const j = App.indexOf("if (!podeAcessar(perfil, rota))");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
    const bloco = App.slice(i, App.indexOf("return children;", i));
    expect(bloco).toMatch(/podeVerPreventivo\(emailPrev\)/);
    expect(bloco).toMatch(/perfil === "operador"/);
    expect(bloco).toMatch(/<Navigate to="\/" replace \/>/);
  });

  it("o item do menu usa a mesma regra e continua barrando operador", () => {
    const i = App.indexOf('if (item.rota === "/preventivo") {');
    expect(i).toBeGreaterThan(-1);
    const bloco = App.slice(i, App.indexOf("}", App.indexOf("return", i)));
    expect(bloco).toMatch(/podeVerPreventivo\(em\)/);
    expect(bloco).toMatch(/perfil !== "operador"/);
  });

  it('"/preventivo" NÃO entra em DIRETORIA_ROTAS (isso abriria a tela a toda a diretoria)', () => {
    const ini = App.indexOf("const DIRETORIA_ROTAS = [");
    const lista = App.slice(ini, App.indexOf("];", ini));
    expect(lista).not.toMatch(/["']\/preventivo["']/);
  });

  it("o gate antigo só-Amanda não restou para /preventivo", () => {
    expect(App).not.toMatch(/\["\/borderos"[^\]]*"\/preventivo"[^\]]*\]\.includes\(rota\)/);
  });
});

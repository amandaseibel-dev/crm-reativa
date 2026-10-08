import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { podeGerirFinanceiro } from "./operadores";

// ACESSO DA FILA UNICA DE CONFIRMACAO.
//
// A rota `/fila-unica-confirmacao` NAO esta nas listas de `permissoes` de
// App.jsx -- e nao deve estar, porque aquelas listas sao por PERFIL e esta
// tela e por PESSOA: quem pode decidir sobre titulo em confirmacao. O efeito
// colateral era que `podeAcessar` devolvia `undefined`, o item desaparecia do
// menu para todo mundo e a tela so era alcancavel pelo link da Efetividade.
//
// A regra passou a ser `podeGerirFinanceiro` -- a MESMA que a ficha do aluno
// (`FinanceiroAluno`) e a propria fila ja usam para liberar a decisao. Nao ha
// perfil novo nem regra paralela, e e isso que estes testes travam: tanto a
// exibicao no menu quanto a porta da rota tem de passar por ELA, e o item nao
// pode voltar a depender de `podeAcessar`.
const App = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"), "utf8");

const ROTA = "/fila-unica-confirmacao";

describe("Fila Única de Confirmação — quem entra é a gestão financeira", () => {
  it("a regra é a que já existe, não uma lista nova em App.jsx", () => {
    expect(App).toContain('import { podeGerirFinanceiro } from "./utils/operadores"');
    // nenhuma lista de e-mails escrita a mao em volta desta rota: cada ponto
    // de decisao dela chama a regra, nao repete a roda de quem pode.
    let de = App.indexOf(ROTA);
    let vistos = 0;
    while (de > -1) {
      expect(App.slice(Math.max(0, de - 200), de + 320)).not.toMatch(/@aelbra\.com\.br/);
      vistos += 1;
      de = App.indexOf(ROTA, de + 1);
    }
    expect(vistos).toBeGreaterThanOrEqual(3); // menu, Route e RotaProtegida
  });

  it("o menu exibe o item pela regra — e não por perfil", () => {
    const i = App.indexOf(`if (item.rota === "${ROTA}")`);
    expect(i).toBeGreaterThan(-1);
    const bloco = App.slice(i, i + 320);
    expect(bloco).toContain("podeGerirFinanceiro(");
    // nao cai no gate por perfil: o branch devolve a decisao ele mesmo
    expect(bloco).toMatch(/return podeGerirFinanceiro\(/);
  });

  it("a rota é protegida pela MESMA regra, não apenas escondida no menu", () => {
    // 1. a rota passa por RotaProtegida
    const rota = App.slice(App.indexOf(`<Route path="${ROTA}"`), App.indexOf(`<Route path="${ROTA}"`) + 260);
    expect(rota).toContain(`<RotaProtegida usuario={usuario} rota="${ROTA}">`);
    // 2. e RotaProtegida decide esta rota por podeGerirFinanceiro
    const guarda = App.slice(App.indexOf("function RotaProtegida"),
                             App.indexOf("function RotaProtegida") + 1600);
    expect(guarda).toContain(`if (rota === "${ROTA}")`);
    expect(guarda).toContain("podeGerirFinanceiro(");
  });

  it("a decisão da porta é a mesma da decisão dentro da tela", () => {
    // quem a regra libera (gestao financeira) e quem ela recusa
    expect(podeGerirFinanceiro("amanda.seibel@aelbra.com.br")).toBe(true);
    expect(podeGerirFinanceiro("cobranca04@aelbra.com.br")).toBe(true);
    expect(podeGerirFinanceiro("cobranca07@aelbra.com.br")).toBe(true);
    expect(podeGerirFinanceiro("cobranca03@aelbra.com.br")).toBe(false);
    expect(podeGerirFinanceiro("")).toBe(false);
    expect(podeGerirFinanceiro(null)).toBe(false);
  });

  it("a rota continua FORA das listas por perfil — senão a regra teria dois donos", () => {
    const permissoes = App.slice(App.indexOf("const permissoes = {"),
                                 App.indexOf("return permissoes[perfil]?.includes(rota)"));
    expect(permissoes).not.toContain(ROTA);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// GUARDA DO PAINEL DOS DOIS INDICADORES -- SOMENTE LEITURA.
//
// A ordem da gestao de 20/10/2026 tem duas partes, e as duas sao verificaveis
// no proprio arquivo:
//   "mantenha dois indicadores distintos" -> o painel le as duas views e nao
//   funde as duas fontes num campo so;
//   "nao implemente baixa automatica sem validacao oficial" -> nenhum caminho
//   de escrita pode existir aqui. Nem botao, nem RPC, nem insert.
//
// Estes testes olham o CODIGO porque e disso que se trata: um `supabase.rpc`
// acrescentado sem querer neste arquivo vira escrita em producao, e nenhum
// teste de banco pegaria isso.
const RAIZ = new URL("../..", import.meta.url).pathname;
const PAINEL = join(RAIZ, "src", "components", "CentralFinanceiraIndicadores.jsx");
const TELA = join(RAIZ, "src", "pages", "ConferenciaPagamentos.jsx");

const painel = readFileSync(PAINEL, "utf8");
const tela = readFileSync(TELA, "utf8");
// Comentario nao e codigo: o cabecalho CITA a ordem da gestao, que fala de
// "baixa automatica", e proibir o padrao sem tirar os comentarios faria o
// teste acusar a propria explicacao do que ele proibe.
const codigo = painel.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

describe("painel dos dois indicadores: nenhum caminho de escrita", () => {
  it("nao chama RPC nem escreve pela API", () => {
    expect(codigo).not.toMatch(/supabase\s*\.\s*rpc\s*\(/);
    expect(codigo).not.toMatch(/\.\s*(insert|update|upsert|delete)\s*\(/);
    expect(codigo).not.toMatch(/supabase\s*\.\s*functions/);
    expect(codigo).not.toMatch(/supabase\s*\.\s*storage/);
  });

  it("le exatamente as duas views, e so com select", () => {
    const tabelas = [...codigo.matchAll(/\.from\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(tabelas.sort()).toEqual(["VISAO_EXCECOES", "VISAO_INDICADORES"]);
    expect(codigo).toContain('VISAO_INDICADORES = "vw_central_financeira_pagamento_indicadores"');
    expect(codigo).toContain('VISAO_EXCECOES = "vw_central_financeira_pagamento_excecoes"');
    // Toda leitura pagina: a API corta em 1.000 linhas e responde 206, que e
    // sucesso -- a janela de 30 dias tem mais de 1.200 linhas em cada view.
    expect([...codigo.matchAll(/buscarTudo\(/g)]).toHaveLength(2);
    expect([...codigo.matchAll(/\.range\(/g)]).toHaveLength(2);
  });

  it("o unico type=submit/acao e recarregar, filtrar e fechar", () => {
    // Todo botao e type="button": nenhum submit, nenhum form.
    const botoes = [...codigo.matchAll(/<button([^>]*)>/g)].map((m) => m[1]);
    expect(botoes.length).toBeGreaterThan(0);
    expect(botoes.every((b) => /type="button"/.test(b))).toBe(true);
    expect(codigo).not.toMatch(/<form/);
  });
});

describe("painel dos dois indicadores: as duas fontes nao se misturam", () => {
  it("cada celula de indicador le colunas de UMA fonte so", () => {
    // Indicador 1 so pode ler crm_*; indicador 2 so baixa_*. Se alguem
    // trocar, o nome da coluna delata.
    expect(codigo).toMatch(/crm_status_conciliacao/);
    expect(codigo).toMatch(/baixa_oficial_existe/);
    // E nao pode existir um campo-sintese inventado na tela.
    expect(codigo).not.toMatch(/estaBaixado|jaBaixado|situacaoFinal|statusUnico/i);
  });

  it("a baixa oficial nunca e deduzida da conciliacao, nem o contrario", () => {
    // Proibe COMBINAR as duas fontes numa expressao -- `&&`, `||`, ternario,
    // comparacao. Citar as duas na lista de colunas do `.select()` e outra
    // coisa: ali elas estao lado a lado, que e exatamente o objetivo.
    const operadores = String.raw`(?:&&|\|\||\?|===|!==|==|!=)`;
    const semSelect = codigo.split("\n").filter((l) => !l.includes(".select(")).join("\n");
    expect(semSelect).not.toMatch(new RegExp(`crm_status_conciliacao[^\n]*${operadores}[^\n]*baixa_oficial`));
    expect(semSelect).not.toMatch(new RegExp(`baixa_oficial[^\n]*${operadores}[^\n]*crm_status_conciliacao`));
  });

  it("a pista fraca por CPF+data+valor e rotulada como NAO vinculo", () => {
    expect(codigo).toMatch(/baixa_candidata_fraca_qtd/);
    expect(painel).toMatch(/n[aã]o é vínculo/i);
  });
});

describe("painel dos dois indicadores: portao e montagem", () => {
  it("so abre para os tres e-mails da gestao financeira", () => {
    expect(codigo).toContain("amanda.seibel@aelbra.com.br");
    expect(codigo).toContain("cobranca04@aelbra.com.br");
    expect(codigo).toContain("cobranca07@aelbra.com.br");
    expect(codigo).toMatch(/if \(!eGestaoFinanceira\) return null;/);
  });

  it("mora dentro da tela de conferencia que ja existe, nao em rota nova", () => {
    expect(tela).toContain('import CentralFinanceiraIndicadores from "../components/CentralFinanceiraIndicadores"');
    expect(tela).toContain("<CentralFinanceiraIndicadores />");
  });
});

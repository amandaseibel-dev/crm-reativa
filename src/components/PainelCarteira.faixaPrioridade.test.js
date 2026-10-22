// Ligacao da faixa de prioridade na Minha Carteira. Leitura do codigo-fonte,
// como os outros testes estruturais do PainelCarteira (a tela inteira nao
// renderiza em teste: ela carrega carteira, acordos, titulos, agenda e
// indicadores). O recorte esta em utils/carteiraFila.prioridade.test.js e a
// faixa em FaixaPrioridadeCarteira.test.jsx.
//
// O que estas guardas protegem:
//   - a contagem do chip e medida sobre o MESMO recorte que o clique abre;
//   - a pesquisa alcanca a carteira inteira, e `matricula` chega do banco;
//   - o filtro de PRAZO continua existindo e separado do de classificacao;
//   - limpar os filtros da barra tambem solta a faixa.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "PainelCarteira.jsx"), "utf8");

describe("PainelCarteira: faixa de prioridade", () => {
  it("a contagem sai do mesmo recorte que o clique abre (sem o filtro de faixa)", () => {
    const i = SRC.indexOf("const contagemPrioridade = useMemo(");
    expect(i).toBeGreaterThan(-1);
    const bloco = SRC.slice(i, i + 600);
    expect(bloco).toMatch(/contarPorPrioridade\(/);
    // Com faixa ligada, mede o recorte SEM ela -- senao as outras faixas
    // apareceriam zeradas e o operador acharia que os casos sumiram.
    expect(bloco).toMatch(/montarListaFiltrada\(\{ \.\.\.recorteAtual, filtroPrioridade: "TODAS" \}\)/);
    expect(bloco).not.toMatch(/contarPorPrioridade\(casos\)/);
  });

  it("a faixa recebe contagem, selecao e callback -- nao conta por conta propria", () => {
    const i = SRC.indexOf("<FaixaPrioridadeCarteira");
    expect(i).toBeGreaterThan(-1);
    const bloco = SRC.slice(i, i + 300);
    expect(bloco).toMatch(/contagens=\{contagemPrioridade\}/);
    expect(bloco).toMatch(/selecionada=\{filtroPrioridade\}/);
    expect(bloco).toMatch(/onSelecionar=\{setFiltroPrioridade\}/);
  });

  it("o recorte recebe a faixa e a carteira fora da fila", () => {
    const i = SRC.indexOf("const recorteAtual = {");
    const bloco = SRC.slice(i, i + 500);
    expect(bloco).toMatch(/\bfiltroPrioridade,/);
    expect(bloco).toMatch(/\bcasosForaDaFila,/);
  });

  it("limpar os filtros da barra tambem solta a faixa (o card promete e cumpre)", () => {
    const i = SRC.indexOf("function limparFiltrosDaBarra()");
    const bloco = SRC.slice(i, i + 400);
    expect(bloco).toMatch(/setFiltroPrioridade\("TODAS"\)/);
  });

  it("matricula vem do banco e a pesquisa anuncia que busca por ela", () => {
    expect(SRC).toMatch(/"id,nome,nome_aluno,cpf,matricula,telefone/);
    expect(SRC).toMatch(/placeholder="Pesquisar por nome, CPF, matrícula ou telefone\.\.\."/);
  });

  it("a carteira fora da fila e guardada separada de `casos` (nao entra na fila nem nos indicadores)", () => {
    const i = SRC.indexOf("setCasosForaDaFila(");
    expect(i).toBeGreaterThan(-1);
    const bloco = SRC.slice(i - 400, i + 300);
    // Nasce do complemento da lista ativa, marcado, e `casos` segue sendo a lista ativa.
    expect(bloco).toMatch(/setCasos\(listaAtiva\)/);
    expect(bloco).toMatch(/_foraDaFila: true/);
  });

  it("o filtro de PRAZO continua existindo, com os mesmos valores, e diz que e prazo", () => {
    const i = SRC.indexOf('value={filtroStatus}');
    const bloco = SRC.slice(i, i + 1200);
    for (const v of ["TODOS", "Novo", "Dentro do prazo", "Atencao", "Critico", "Perdendo o caso", "Aguardando pgto", "Juridico"]) {
      expect(bloco).toContain(`value="${v}"`);
    }
    expect(bloco).toMatch(/Todos os prazos/);
    expect(bloco).toMatch(/não é a classificação de criticidade/);
  });

  it("a ordenacao por prioridade anuncia a ordem que entrega", () => {
    expect(SRC).toMatch(/<option value="prioridade">Prioridade \(Perdendo → Crítico → Urgente → Atenção → Novo → Normal\)<\/option>/);
  });

  it("nao mexe na correcao das mensalidades (PR #731)", () => {
    expect(SRC).toMatch(/<BotaoMensalidades/);
    expect(SRC).toMatch(/<LinhaMensalidades/);
    expect(SRC).toMatch(/fin\[id\]\.itensMensalidades\.push\(\{/);
  });
});

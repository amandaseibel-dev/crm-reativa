// Ligacao do detalhamento das mensalidades na tabela da Minha Carteira.
// Leitura do codigo-fonte, como os outros testes estruturais do PainelCarteira
// (a tela inteira nao renderiza em teste: ela carrega carteira, acordos,
// titulos, agenda e indicadores). O comportamento do clique e da expansao esta
// em MensalidadesDoAluno.test.jsx, com DOM de verdade.
//
// O que estas guardas protegem:
//   - o detalhamento abre com os dados que a tela JA carregou (nada de consulta
//     por clique);
//   - a linha detalhada mostra o MESMO valor que foi somado -- nenhuma conta
//     nova, nenhuma regra financeira nova;
//   - a linha extra fica FORA da <tr> do aluno, que abre o atendimento.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "PainelCarteira.jsx"), "utf8");

describe("PainelCarteira: detalhamento das mensalidades", () => {
  it("pede competencia e documento na MESMA consulta de titulos (sem ida extra por clique)", () => {
    expect(SRC).toMatch(
      /\.select\("aluno_id,status,situacao,acordo_id,valor_em_aberto,saldo_corrigido,valor_original,vencimento,documento,competencia"\)/
    );
    // Uma consulta de titulos e so uma: o painel nao pode ter criado outra.
    expect(SRC.match(/from\("acordos_titulos"\)/g)).toHaveLength(1);
  });

  it("guarda a linha com o MESMO valor que somou em mensalidades", () => {
    const inicio = SRC.indexOf("fin[id].mensalidades += v;");
    expect(inicio).toBeGreaterThan(-1);
    const bloco = SRC.slice(inicio, inicio + 1200);
    expect(bloco).toMatch(/fin\[id\]\.itensMensalidades\.push\(\{/);
    expect(bloco).toMatch(/valor: v,/);
    expect(bloco).toMatch(/vencida: d !== null && d > 0,/);
    expect(bloco).toMatch(/competencia: t\.competencia \|\| null,/);
  });

  it("as negociadas NAO entram na lista: o painel decompoe so o que forma o total", () => {
    // O `continue` das vinculadas vem ANTES do push -- se alguem mover o push
    // para cima dele, o painel passaria a listar divida ja contada em Acordos.
    const negociada = SRC.indexOf("if (negociada) {");
    const push = SRC.indexOf("fin[id].itensMensalidades.push({");
    expect(negociada).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(negociada);
    const bloco = SRC.slice(negociada, push);
    expect(bloco).toMatch(/continue;/);
  });

  it("a caixinha virou botao, com o valor de sempre e a quantidade que vai abrir", () => {
    const i = SRC.indexOf("<BotaoMensalidades");
    expect(i).toBeGreaterThan(-1);
    const bloco = SRC.slice(i, i + 500);
    expect(bloco).toMatch(/qtd=\{itensMens\.length\}/);
    expect(bloco).toMatch(/valorRotulo=\{formatarMoeda\(fa\.mensalidades\)\}/);
    expect(bloco).toMatch(/onAlternar=\{\(\) => alternarMensalidades\(a\.id\)\}/);
    // Sem mensalidade para abrir, continua texto: botao que abre o vazio e pior
    // que texto.
    expect(SRC).toMatch(/itensMens\.length > 0 \? \(/);
  });

  it("a linha de detalhamento fica FORA da <tr> do aluno (que abre o atendimento)", () => {
    const fim = SRC.indexOf("{mensAberto && (");
    expect(fim).toBeGreaterThan(-1);
    // Logo acima do detalhamento esta o fechamento da linha do aluno.
    expect(SRC.slice(fim - 400, fim)).toMatch(/<\/tr>/);
    const bloco = SRC.slice(fim, fim + 400);
    expect(bloco).toMatch(/<LinhaMensalidades/);
    expect(bloco).toMatch(/totalRotulo=\{formatarMoeda\(fa\.mensalidades\)\}/);
  });

  it("o colSpan do detalhamento acompanha o numero de colunas da tabela", () => {
    const cabeca = SRC.slice(SRC.indexOf('<table style={S.tabela} className="pc-tabela">'));
    const colunas = cabeca.slice(0, cabeca.indexOf("</thead>")).match(/<th style=\{S\.(th|thNum)\}>/g);
    const detalhe = SRC.slice(SRC.indexOf("{mensAberto && ("), SRC.indexOf("{mensAberto && (") + 400);
    expect(detalhe).toMatch(new RegExp(`colSpan=\\{${colunas.length}\\}`));
  });

  it("abrir o detalhamento nao toca filtro, ordenacao nem titularidade", () => {
    const i = SRC.indexOf("function alternarMensalidades(");
    expect(i).toBeGreaterThan(-1);
    const bloco = SRC.slice(i, i + 500);
    expect(bloco).toMatch(/setMensalidadesAbertas/);
    // A funcao so mexe no proprio Set.
    expect(bloco).not.toMatch(/setFiltro|limparFiltrosDaBarra|setOrdenacao|setCasos\b|supabase/);
  });
});

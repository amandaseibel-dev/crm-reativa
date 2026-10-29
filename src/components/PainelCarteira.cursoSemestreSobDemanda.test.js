// A leitura de curso/semestre e SOB DEMANDA (26/10/2026, incidente de carga).
//
// Teste por leitura do codigo-fonte: o componente e grande demais para montar
// em teste -- mesmo motivo de PainelCarteira.meuDia.test.js e
// PainelCarteira.alertaD2.test.js.
//
// O QUE ISTO PROTEGE, medido em PROD em 26/10/2026:
//   `carteira_curso_semestre_do_operador` e a consulta mais cara da tela --
//   piso de 3,07 s, media de 4,86 s, pior caso 7,97 s e ~48 MB de disco
//   temporario POR CHAMADA, contra o teto de 8 s do papel `authenticated`.
//   Ela saia em TODA abertura de carteira, para todo operador, inclusive quem
//   nunca toca no recorte. Enquanto isso a lista de casos (consulta de
//   `alunos`, media de 83 ms) morria com erro 500 por saturacao do banco.
//
//   Se alguem voltar a dispara-la no padrao da tela, o incidente volta.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(AQUI, "PainelCarteira.jsx"), "utf8");
const UTIL = readFileSync(resolve(AQUI, "../utils/carteiraFila.js"), "utf8");

// A janela e o BLOCO inteiro da leitura sob demanda, do calculo do escopo ate
// o mapa validado por escopo. Janela de N caracteres a partir de um marcador
// reprova sozinha quando uma linha nova entra no meio -- armadilha ja paga
// em 22/10/2026.
function blocoSobDemanda() {
  const i = SRC.indexOf("const escopoCursoSemestre =");
  const fim = SRC.indexOf("const mapaCursoSemestreValido =");
  if (i < 0 || fim < 0) return "";
  return SRC.slice(i, fim);
}

describe("PainelCarteira: curso/semestre nao custa nada na abertura", () => {
  it("a RPC existe uma unica vez na tela", () => {
    const todas = SRC.match(/rpc\("carteira_curso_semestre_do_operador"/g) || [];
    expect(todas).toHaveLength(1);
  });

  it("a chamada esta atras do portao de demanda", () => {
    const bloco = blocoSobDemanda();
    expect(bloco).toMatch(/rpc\("carteira_curso_semestre_do_operador"/);
    // O portao vem ANTES da chamada, e devolve sem ir ao banco.
    const portao = bloco.indexOf("if (!pedeCursoSemestre) return;");
    const chamada = bloco.indexOf('rpc("carteira_curso_semestre_do_operador"');
    expect(portao).toBeGreaterThanOrEqual(0);
    expect(portao).toBeLessThan(chamada);
  });

  it("quem decide e o utilitario testado, pelos filtros da tela", () => {
    expect(SRC).toMatch(
      /const pedeCursoSemestre = cursoSemestrePedido\(filtroCurso, filtroSemestre\)/
    );
    expect(SRC).toMatch(/estadoRecorteCursoSemestre,\n[\s\S]*\} from "\.\.\/utils\/carteiraFila"/);
    expect(UTIL).toMatch(/export function cursoSemestrePedido\(curso, semestre\)/);
  });

  it("o efeito NAO dispara por montagem: a demanda esta nas dependencias", () => {
    const bloco = blocoSobDemanda();
    // As dependencias do efeito. Sem `pedeCursoSemestre` ali, o efeito voltaria
    // a correr na abertura da tela.
    expect(bloco).toMatch(
      /\}, \[pedeCursoSemestre, escopoCursoSemestre, escopoCursoSemestreLido\]\)/
    );
    // E nao sobrou o efeito antigo, que dependia so do escopo.
    expect(bloco).not.toMatch(/\}, \[email, veTudo, operadorFiltro\]\)/);
  });

  it("uma leitura por escopo: carregado, trocar o select nao volta ao banco", () => {
    const bloco = blocoSobDemanda();
    expect(bloco).toMatch(/if \(escopoCursoSemestreLido === escopoCursoSemestre\) return;/);
    // O escopo carrega os tres eixos que definem de quem e a carteira.
    expect(SRC).toMatch(
      /const escopoCursoSemestre = `\$\{email \|\| ""\}\|\$\{veTudo \? "1" : "0"\}\|\$\{operadorFiltro \|\| ""\}`/
    );
  });

  it("a falha segue tolerada: mapa nulo nao encolhe a lista", () => {
    const bloco = blocoSobDemanda();
    expect(bloco).toMatch(/if \(error\) \{ setMapaCursoSemestre\(null\); return; \}/);
    // `null` nao filtra -- a garantia mora no utilitario e e testada la.
    expect(UTIL).toMatch(/if \(!c \|\| c === "TODOS"\) return null;/);
  });

  it("os selects NAO ficam presos esperando o mapa", () => {
    // Era `disabled={mapaCursoSemestre === null}`. Com a leitura sob demanda
    // isso trancaria o filtro para sempre: o mapa so chega depois de escolher,
    // e nao se escolhe num select desabilitado. Ovo e galinha.
    expect(SRC).not.toMatch(/disabled=\{mapaCursoSemestre === null\}/);
    const presos = SRC.match(/disabled=\{cursoSemestreCarregando\}/g) || [];
    expect(presos).toHaveLength(2);
  });

  it("o recorte usa o mapa VALIDADO por escopo, nunca o cru", () => {
    // Trocar de operador na gestao nao pode recortar pela carteira anterior.
    expect(SRC).toMatch(
      /const mapaCursoSemestreValido =\s*\n\s*escopoCursoSemestreLido === escopoCursoSemestre \? mapaCursoSemestre : null;/
    );
    for (const consumidor of [
      "alunosDoCursoEscolhido",
      "alunosDoSemestreEscolhido",
      "finAlunosDoSemestre",
    ]) {
      const re = new RegExp(`${consumidor}\\((finAlunos, )?mapaCursoSemestreValido`);
      expect(SRC).toMatch(re);
    }
    // Nenhum consumidor ficou no mapa cru.
    expect(SRC).not.toMatch(/alunosDoCursoEscolhido\(mapaCursoSemestre,/);
    expect(SRC).not.toMatch(/alunosDoSemestreEscolhido\(mapaCursoSemestre,/);
    expect(SRC).not.toMatch(/finAlunosDoSemestre\(finAlunos, mapaCursoSemestre,/);
  });

  it("a carga principal da carteira nao depende dessa RPC", () => {
    // A lista de casos sai de `carregar()`, que nao conhece curso/semestre.
    const i = SRC.indexOf("async function carregar()");
    const fim = SRC.indexOf("async function carregarRetornosPendentes");
    const carregar = i >= 0 && fim > i ? SRC.slice(i, fim) : SRC;
    expect(carregar).not.toMatch(/carteira_curso_semestre_do_operador/);
    expect(carregar).not.toMatch(/mapaCursoSemestre/);
  });
  // Durante a carga de um recorte (ou se a contagem falhou), o total geral NAO
  // pode aparecer como resultado do recorte. O rodape so mostra "Mostrando X de Y"
  // no ramo em que o recorte ja tem dados validados.
  it("recorte carregando: o rodape nao mostra o total geral", () => {
    const guarda = SRC.indexOf("const estadoRecorte = estadoRecorteCursoSemestre(");
    const ramo = SRC.indexOf("{recorteSemDados ? (");
    const total = SRC.indexOf("Mostrando {listaFiltrada.length} de");
    expect(guarda).toBeGreaterThan(-1);
    expect(ramo).toBeGreaterThan(-1);
    expect(total).toBeGreaterThan(ramo);
    expect(SRC.slice(guarda, guarda + 500)).toMatch(/escopoLido: escopoCursoSemestreLido/);
  });
  // Kanban: com recorte sem dados validados, as colunas e contagens NAO aparecem.
  // A mesma condicao protege o rodape e o kanban; sem recorte, ou apos a carga com
  // sucesso (mapa presente), a visualizacao normal continua.
  it("carregamento: o kanban nao mostra colunas nem contagens do total geral", () => {
    expect(SRC).toMatch(/visao === "kanban" && recorteSemDados \? \(/);
    const guarda = SRC.indexOf('visao === "kanban" && recorteSemDados');
    const colunasKanban = SRC.indexOf("{kanbanColunas.map((col) => (");
    expect(guarda).toBeGreaterThan(-1);
    expect(colunasKanban).toBeGreaterThan(guarda);
  });

  it("falha: sem mapa validado, a mensagem de indisponibilidade substitui o total geral", () => {
    expect(SRC).toMatch(/estadoRecorteCursoSemestre\(\{/);
    expect(SRC).toMatch(/estadoRecorteCursoSemestre,/);
    expect(UTIL).toMatch(/Recorte de curso e semestre indisponível/);
    expect(SRC).toMatch(/if \(error\) \{ setMapaCursoSemestre\(null\); return; \}/);
  });

  it("sucesso e sem recorte: a visualizacao normal nao muda", () => {
    // sem recorte, recorteSemDados e falso mesmo com mapa nulo
    expect(UTIL).toMatch(/if \(!cursoSemestrePedido\(filtroCurso, filtroSemestre\)\) \{/);
    // a mensagem tem uma unica fonte, usada no kanban e no rodape
    const ocorrencias = SRC.match(/\{mensagemRecorteSemDados\}/g) || [];
    expect(ocorrencias.length).toBe(2);
  });
});

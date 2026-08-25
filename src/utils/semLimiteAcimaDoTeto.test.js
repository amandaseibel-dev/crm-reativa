import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// GUARDA CONTRA O TETO DE MIL LINHAS.
//
// A API do CRM devolve no maximo 1.000 linhas por requisicao e responde 206
// (Partial Content) -- um codigo de SUCESSO. Ou seja, `.limit(5000)` nao e
// apenas inutil: e uma mentira silenciosa. Quem escreve acredita que pediu
// 5.000, a tela mostra 1.000, e nada no console, no log ou na interface avisa.
//
// Em 25/08/2026 isso escondia R$ 2,36 milhoes em pagamentos abertos da fila de
// confirmacao, contava a produtividade dos operadores sobre 10% das
// movimentacoes, e fazia a Base Receptiva nao encontrar 16.470 alunos que
// existem. Nenhum desses bugs deu erro em lugar nenhum -- foram descobertos
// comparando a tela com o banco, na mao.
//
// Este teste existe para que a proxima vez seja detectada aqui, e nao por
// alguem estranhando um numero seis meses depois.
//
// Quando este teste quebrar, o conserto NAO e aumentar o numero nem silenciar:
//   - se voce quer a lista inteira -> use `buscarTudo` de src/utils/paginado.js;
//   - se voce quer so a contagem   -> `.select("id", { count: "exact", head: true })`;
//   - se voce quer mesmo um recorte pequeno -> peca 1.000 ou menos, com ordem
//     explicita, para o recorte ser deliberado em vez de acidental.

const RAIZ = new URL("..", import.meta.url).pathname;
const TETO = 1000;

function arquivosDeCodigo(dir) {
  const achados = [];
  for (const item of readdirSync(dir)) {
    const caminho = join(dir, item);
    if (statSync(caminho).isDirectory()) {
      achados.push(...arquivosDeCodigo(caminho));
    } else if (/\.(js|jsx)$/.test(item) && !item.includes(".test.")) {
      achados.push(caminho);
    }
  }
  return achados;
}

describe("teto de mil linhas da API", () => {
  it("nenhuma consulta pede .limit() acima de 1000", () => {
    const infratores = [];

    for (const arquivo of arquivosDeCodigo(RAIZ)) {
      const linhas = readFileSync(arquivo, "utf8").split("\n");
      linhas.forEach((linha, i) => {
        // Ignora o que esta em comentario: os arquivos corrigidos EXPLICAM o
        // limite antigo no texto, e explicar o erro nao pode reprovar o teste.
        const semComentario = linha.replace(/\/\/.*$/, "");
        const achado = semComentario.match(/\.limit\((\d+)\)/);
        if (achado && Number(achado[1]) > TETO) {
          infratores.push(
            `${arquivo.replace(RAIZ, "src/")}:${i + 1} pede ${achado[1]}, a API entrega ${TETO}`
          );
        }
      });
    }

    expect(infratores, [
      "",
      "Consulta pedindo mais linhas do que a API entrega.",
      "A resposta volta como sucesso (206) com apenas 1.000 linhas -- sem erro nenhum.",
      "Use buscarTudo() de src/utils/paginado.js, ou count exato se quiser so o numero.",
      "",
      ...infratores,
      "",
    ].join("\n")).toEqual([]);
  });
});

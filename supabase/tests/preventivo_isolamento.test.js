// PREVENTIVO — ISOLAMENTO E PORTAS DE ENTRADA, verificado sobre o repositório
// inteiro, não só sobre o código novo.
//
// Verificar que o Preventivo não ESCREVE na cobrança é metade do problema. A
// outra metade é que nada da cobrança — consulta, gatilho ou rotina — passe a
// LER o Preventivo e o incorpore aos números dela. Estes testes olham para os
// dois lados.
//
// Também trancam o portão da Edge Function e garantem que a configuração de
// preview sem login não tenha como entrar na aplicação publicada.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");

function arquivos(dir, filtro) {
  const saida = [];
  const andar = (d) => {
    for (const nome of readdirSync(d)) {
      if (nome === "node_modules" || nome === ".git" || nome === "dist") continue;
      const caminho = join(d, nome);
      if (statSync(caminho).isDirectory()) andar(caminho);
      else if (filtro(caminho)) saida.push(relative(RAIZ, caminho));
    }
  };
  andar(resolve(RAIZ, dir));
  return saida;
}

// Os arquivos que TÊM o direito de falar em `prev_` / `preventivo_`.
const DO_PREVENTIVO = /(preventivo|prev-sincronizar)/i;

// Comentário citando um nome é explicação, não acoplamento. Tirar antes de
// procurar evita acusar o próprio texto que explica a regra.
function semComentarios(texto) {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(--|\/\/).*$/, "")).join("\n");
}

describe("nada fora do Preventivo conhece o Preventivo", () => {
  it("nenhuma migration da cobrança referencia tabela ou função do Preventivo", () => {
    const intrusos = arquivos("supabase/migrations", (p) => p.endsWith(".sql"))
      .filter((p) => !DO_PREVENTIVO.test(p))
      .filter((p) => /\bprev_[a-z]|\bpreventivo_/i.test(ler(p)));
    expect(intrusos).toEqual([]);
  });

  it("nenhuma tela fora do Preventivo chama uma RPC do Preventivo", () => {
    // App.jsx pode citar a ROTA e o componente; o que não pode é CHAMAR uma
    // RPC do Preventivo de fora dele.
    const intrusos = arquivos("src", (p) => /\.jsx?$/.test(p))
      .filter((p) => !DO_PREVENTIVO.test(p))
      .map((p) => [p, semComentarios(ler(p)).match(/preventivo_[a-z_]+|\bprev_[a-z_]+/gi) || []])
      .filter(([, achados]) => achados.length > 0);
    expect(intrusos).toEqual([]);
  });

  it("nenhuma Edge Function da cobrança lê tabela do Preventivo", () => {
    const intrusos = arquivos("supabase/functions", (p) => p.endsWith(".ts"))
      .filter((p) => !DO_PREVENTIVO.test(p))
      .filter((p) => /\bprev_[a-z]|preventivo_/i.test(ler(p)));
    expect(intrusos).toEqual([]);
  });
});

describe("o Preventivo não entra nas rotinas que varrem o catálogo", () => {
  const semComentario = semComentarios(
    ler("supabase/migrations/20260928143743_preventivo_estrutura.sql"));

  it("nenhuma tabela do Preventivo tem coluna `aluno_id`", () => {
    // `public.mesclar_aluno_duplicado()` (viva em produção) varre TODA tabela
    // com uma coluna chamada exatamente `aluno_id` e reescreve o valor dela.
    expect(semComentario).not.toMatch(/\baluno_id\b/);
  });

  it("nenhuma coluna com 'email' no nome fica sem 'aluno' ao lado", () => {
    // `public.propagar_nome_usuario()` (viva em produção) varre toda coluna
    // com "email" no nome que tenha uma irmã "nome", e sobrescreve a irmã com
    // o nome de um OPERADOR. Ela pula o que tem "aluno" no nome.
    const colunas = [...semComentario.matchAll(/^\s{2}([a-z_]*email[a-z_]*)\s+text/gim)]
      .map((m) => m[1]);
    expect(colunas.length).toBeGreaterThan(0);
    for (const c of colunas) expect([c, /aluno/.test(c)]).toEqual([c, true]);
  });

  it("nenhuma tabela tem, ao mesmo tempo, coluna com 'email' e coluna 'nome'", () => {
    // É esse PAR que `propagar_nome_usuario()` procura. `prev_carteira.nome` é
    // o nome da carteira e existe sozinho, sem irmã de e-mail: fica fora.
    const tabelas = semComentario.split(/create table if not exists public\./).slice(1);
    for (const bloco of tabelas) {
      const nomeTabela = bloco.slice(0, bloco.indexOf(" "));
      const corpo = bloco.slice(0, bloco.indexOf(");"));
      const temEmail = /^\s{2}[a-z_]*email[a-z_]*\s+text/im.test(corpo);
      const temNome = /^\s{2}nome\s+text/im.test(corpo);
      expect([nomeTabela, temEmail && temNome]).toEqual([nomeTabela, false]);
    }
  });
});

describe("o portão da Edge Function vem antes de qualquer coisa", () => {
  const bruta = ler("supabase/functions/prev-sincronizar/index.ts");
  const fonte = semComentarios(bruta);

  it("confere o acesso no BANCO antes de pedir a chave do Prime", () => {
    const gate = fonte.indexOf('rpc("preventivo_e_gestao")');
    const chave = fonte.indexOf("prime_chave_api");
    expect(gate).toBeGreaterThan(-1);
    expect(chave).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(chave);
  });

  it("recusa com 401 sem credencial e 403 para quem não é a gestão", () => {
    expect(fonte).toMatch(/if \(!autorizacao\) return json\(\{ erro: "sem credencial" \}, 401\)/);
    expect(fonte).toMatch(/if \(ehGestao !== true\) return json\([^)]*403\)/);
  });

  it("a lista de quem pode NÃO mora no código da função", () => {
    expect(bruta).not.toMatch(/@aelbra\.com\.br/);
  });

  it("nunca devolve nem registra a chave do Prime", () => {
    // Tira os textos antes de procurar: a mensagem de erro "chave do Prime nao
    // encontrada" fala da chave sem nunca conter a chave.
    const semTexto = fonte.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
    expect(semTexto).not.toMatch(/console\./);
    // nenhuma resposta da função carrega a variável `chave`
    for (const m of semTexto.matchAll(/json\(([^;]*?)\)/g)) {
      expect([m[1].trim().slice(0, 60), /\bchave\b/.test(m[1])]).toEqual([m[1].trim().slice(0, 60), false]);
    }
  });
});

describe("o preview sem login não alcança a aplicação publicada", () => {
  it("nenhum arquivo de src importa o dublê do preview", () => {
    // só importa: a palavra "preview" aparece em telas por outros motivos.
    const intrusos = arquivos("src", (p) => /\.jsx?$/.test(p))
      .filter((p) => /(from|import)\s*\(?\s*["'][^"']*\.preview/.test(ler(p)));
    expect(intrusos).toEqual([]);
  });

  it("o index.html da aplicação não carrega a entrada do preview", () => {
    expect(ler("index.html")).not.toMatch(/\.preview/);
  });

  it("o dublê só é ligado pela config exclusiva do preview", () => {
    const usos = arquivos(".", (p) => /vite.*\.config\.js$/.test(p))
      .filter((p) => /preview-preventivo/.test(ler(p)));
    expect(usos).toEqual(["vite.preview-preventivo.config.js"]);
  });

  it("o dublê se recusa a rodar fora do preview", () => {
    expect(ler(".preview-preventivo/mock-supabase.js"))
      .toMatch(/import\.meta\.env\.PROD/);
  });
});

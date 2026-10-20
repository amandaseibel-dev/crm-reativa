// O painel de diagnóstico da Prime, lido como TEXTO.
//
// Por que existe separado do teste de tela: estas asserções não precisam de
// DOM, e algumas delas são sobre o que o arquivo NÃO contém -- coisa que só se
// prova lendo a fonte, não exercitando a tela. Padrão que
// `PainelCarteira.meuDia.test.js` já usa aqui.
//
// O que prende:
//   1. a entrega NUNCA toca em credencial: não lê armazenamento do navegador,
//      não monta header de autorização, não menciona chave nem portador de
//      token. É a razão de ser do PR -- a sessão vai anexada pelo cliente;
//   2. nenhum caminho de escrita: sem insert/update/delete/upsert, sem `from(`;
//   3. a única RPC é o portão de gestão e a única Edge Function é a sonda;
//   4. `supabase/functions/` fica intocado: a tela usa a função como ela está.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const TELA = readFileSync(resolve(AQUI, "DiagnosticoPrime.jsx"), "utf8");
const UTIL = readFileSync(resolve(AQUI, "../utils/primeSonda.js"), "utf8");
const OS_DOIS = [["DiagnosticoPrime.jsx", TELA], ["primeSonda.js", UTIL]];

describe("nenhuma credencial é manuseada", () => {
  it.each(OS_DOIS)("%s não lê armazenamento do navegador nem monta autorização", (_nome, fonte) => {
    for (const proibido of [
      /localStorage/,
      /sessionStorage/,
      /document\.cookie/,
      /indexedDB/,
      /Authorization/i,
      /apikey/i,
      /access_token/,
      /Bearer/,
      /getSession/,
      /setSession/,
    ]) expect(fonte).not.toMatch(proibido);
  });

  it("a chamada é pelo cliente do app, que anexa a sessão sozinho", () => {
    expect(TELA).toMatch(/import \{ supabase \} from "\.\.\/services\/supabase"/);
    expect(TELA).toMatch(/supabase\.functions\.invoke\(\s*"prime-sonda"/);
  });
});

describe("nenhum caminho de escrita", () => {
  it.each(OS_DOIS)("%s não tem insert/update/delete/upsert nem from(", (_nome, fonte) => {
    for (const proibido of [".insert(", ".update(", ".delete(", ".upsert(", ".from("]) {
      expect(fonte).not.toContain(proibido);
    }
  });

  it("a única RPC é `usuario_e_gestao`", () => {
    const rpcs = [...TELA.matchAll(/\.rpc\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(rpcs).toEqual(["usuario_e_gestao"]);
  });

  it("a única Edge Function invocada é `prime-sonda`", () => {
    const fns = [...TELA.matchAll(/functions\.invoke\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(fns).toEqual(["prime-sonda"]);
  });

  it("o corpo enviado é só { caminho, cru } -- nada de método, header ou chave", () => {
    expect(TELA).toMatch(/body:\s*\{\s*caminho,\s*cru:\s*true\s*\}/);
    expect(TELA).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/i);
  });
});

describe("nesta versão não há como exibir resposta bruta", () => {
  it("não existe checkbox, <pre> nem impressão do corpo da resposta", () => {
    for (const proibido of [/type="checkbox"/, /<pre/, /JSON\.stringify\(\s*(r\.)?corpo/, /identificável/i]) {
      expect(TELA).not.toMatch(proibido);
    }
  });

  it("o corpo nunca entra no estado da tela", () => {
    // `setResultados` só recebe `resultado`/`feitos`/planos -- nunca `corpo`.
    expect(TELA).not.toMatch(/setResultados\([^)]*corpo/);
    expect(TELA).not.toMatch(/useState\([^)]*corpo/);
    // e o corpo só é lido por quem calcula o veredito
    const usos = [...TELA.matchAll(/corpos?\b/g)].length;
    expect(usos).toBeGreaterThan(0); // existe, como variável local
    expect(TELA).toMatch(/respostasIdenticas\(corpos\.t1, corpos\.t2\)/);
  });
});

describe("as travas de chamada não são cosméticas", () => {
  it("os valores de produção são os do código, não os do teste", () => {
    expect(TELA).toMatch(/const PAUSA_PADRAO_MS = 900;/);
    expect(TELA).toMatch(/const JANELA_PADRAO_MS = 30000;/);
    expect(TELA).toMatch(/pausaEntreChamadasMs = PAUSA_PADRAO_MS/);
    expect(TELA).toMatch(/janelaRepeticaoMs = JANELA_PADRAO_MS/);
  });

  it("a trava de simultaneidade é um ref, não só o `disabled` do botão", () => {
    expect(TELA).toMatch(/const emCurso = useRef\(false\)/);
    // os dois disparadores saem cedo se já houver chamada no ar
    expect([...TELA.matchAll(/if \(emCurso\.current\) return;/g)].length).toBe(2);
    // e sempre destravam, mesmo se a chamada estourar
    expect([...TELA.matchAll(/emCurso\.current = false;/g)].length).toBe(2);
    expect([...TELA.matchAll(/\} finally \{/g)].length).toBe(2);
  });

  it("a janela é conferida ANTES de invocar a sonda", () => {
    // dentro de `consultar`, não no comentário de cabeçalho
    const corpoDaFuncao = TELA.slice(TELA.indexOf("const consultar = useCallback"));
    const janela = corpoDaFuncao.search(/Date\.now\(\) - quando < janelaRepeticaoMs/);
    const chamada = corpoDaFuncao.search(/supabase\.functions\.invoke/);
    expect(janela).toBeGreaterThan(-1);
    expect(chamada).toBeGreaterThan(-1);
    expect(janela).toBeLessThan(chamada);
  });
});

describe("a Edge Function não foi tocada por esta entrega", () => {
  const INDEX = readFileSync(resolve(AQUI, "../../supabase/functions/prime-sonda/index.ts"), "utf8");
  it("continua sendo GET e continua exigindo o portão", () => {
    expect(INDEX).toMatch(/method:\s*"GET"/);
    expect(INDEX).toMatch(/decidirAcesso/);
    expect(INDEX).toMatch(/caminhoPermitido/);
  });
});

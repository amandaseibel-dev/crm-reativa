// A tela branca de 20/08/2026 nao foi bug de React: foi o Google Translate.
//
// O `index.html` declarava `lang="en"` numa aplicacao inteiramente em
// portugues. O Chrome traduz sozinho nesse caso, e o Translate substitui cada
// no de texto por um `<font>`. O React segue com referencia aos nos originais e
// quebra com `NotFoundError: Failed to execute 'insertBefore' on 'Node'` —
// derrubando a arvore inteira. Abrir uma conversa, que troca dezenas de nos de
// texto de uma vez, era o gatilho mais provavel.
//
// Este teste existe porque a protecao mora numa LINHA DE HTML que ninguem olha,
// e uma regressao aqui volta a derrubar a Central sem deixar rastro no console
// de quem nao souber o que procurar.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(join(raiz, "index.html"), "utf8");

describe("index.html — o navegador nao pode traduzir a aplicacao", () => {
  it("declara portugues, e nao o `en` do template do Vite", () => {
    expect(html).toMatch(/<html[^>]*\blang="pt-BR"/);
    expect(html).not.toMatch(/<html[^>]*\blang="en"/);
  });

  it("marca `translate=\"no\"` no elemento raiz", () => {
    expect(html).toMatch(/<html[^>]*\btranslate="no"/);
  });

  it("tem a meta `notranslate` — trava para quem ja marcou 'traduzir sempre'", () => {
    expect(html).toMatch(/<meta\s+name="google"\s+content="notranslate"\s*\/?>/);
  });

  it("mantem a explicacao no arquivo: sem ela alguem 'limpa' e a Central cai de novo", () => {
    expect(html).toMatch(/insertBefore/);
  });
});

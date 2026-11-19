import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Aba "📺 TV ReATIVA" e a retirada do "📝 Mensagem da TV" (12/11/2026).
const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "App.jsx"), "utf8");

describe("aba TV ReATIVA abre a nova TV", () => {
  it("o link aponta para a TV publicada no Netlify", () => {
    expect(app).toMatch(/const URL_TV_REATIVA = "https:\/\/reativa-tv\.netlify\.app\/";/);
    expect(app).toMatch(/\{ rota: "\/tv", label: "📺 TV ReATIVA",[^}]*externo: true, href: URL_TV_REATIVA \}/);
  });
  it("o link externo usa o href do item, com a rota como reserva", () => {
    expect(app).toMatch(/href=\{item\.href \|\| item\.rota\}/);
  });
  it("a rota interna /tv do telão continua existindo (usuário técnico da TV antiga)", () => {
    expect(app).toMatch(/\["\/tv-elogios", "\/tv"\]\.includes\(window\.location\.pathname\)/);
  });
});

describe("configuração da TV antiga fora da interface", () => {
  it("sem item de menu 'Mensagem da TV'", () => {
    expect(app).not.toMatch(/label: "📝 Mensagem da TV"/);
    expect(app).not.toMatch(/rota: "\/tv-mensagem"/);
  });
  it("a tela não é mais carregada e o endereço antigo volta para o início", () => {
    expect(app).not.toMatch(/import\("\.\/pages\/TvMensagem"\)/);
    expect(app).not.toMatch(/<TvMensagem \/>/);
    expect(app).toMatch(/<Route path="\/tv-mensagem" element=\{<Navigate to="\/" replace \/>\} \/>/);
  });
});

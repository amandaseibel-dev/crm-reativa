// Prova: com escape, `_` e `%` não viram curingas. Simula o LIKE do Postgres (escape `\`).
import { describe, it, expect } from "vitest";
import { escaparLike, emailNormalizado } from "./email_exato.ts";

function likePostgres(texto: string, padrao: string): boolean {
  let re = "^";
  for (let i = 0; i < padrao.length; i++) {
    const c = padrao[i];
    if (c === "\\" && i + 1 < padrao.length) { re += padrao[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (c === "%") re += ".*";
    else if (c === "_") re += ".";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$", "is").test(texto);
}

describe("e-mail exato", () => {
  it("underscore nao casa outro caractere", () => {
    expect(likePostgres("axb@aelbra.com.br", escaparLike("a_b@aelbra.com.br"))).toBe(false);
    expect(likePostgres("a_b@aelbra.com.br", escaparLike("a_b@aelbra.com.br"))).toBe(true);
  });
  it("percentual nao vira curinga", () => {
    expect(likePostgres("ana@aelbra.com.br", escaparLike("%@aelbra.com.br"))).toBe(false);
    expect(likePostgres("%@aelbra.com.br", escaparLike("%@aelbra.com.br"))).toBe(true);
  });
  it("barra invertida escapada", () => {
    expect(likePostgres("a\\b@x", escaparLike("a\\b@x"))).toBe(true);
    expect(likePostgres("ab@x", escaparLike("a\\b@x"))).toBe(false);
  });
  it("caixa: ilike casa variacao de maiuscula (comportamento preservado)", () => {
    expect(emailNormalizado("  Amanda.Seibel@AELBRA.com.br ")).toBe("amanda.seibel@aelbra.com.br");
  });
  it("prefixo e sufixo nao casam", () => {
    expect(likePostgres("amanda.seibel@aelbra.com.br.evil", escaparLike("amanda.seibel@aelbra.com.br"))).toBe(false);
    expect(likePostgres("xamanda.seibel@aelbra.com.br", escaparLike("amanda.seibel@aelbra.com.br"))).toBe(false);
  });
});

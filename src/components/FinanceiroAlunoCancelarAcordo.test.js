// O aviso do botao "Cancelar acordo" da ficha tem de dizer o que o banco faz
// desde 25/09/2026 (versao 20260925123852): acordo cancelado sem pagamento
// devolve as mensalidades para em aberto; so fica negociada a que veio de um
// acordo anterior que recebeu pagamento (saldo residual). Ate 25/09 o aviso
// dizia o contrario.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FICHA = join(dirname(fileURLToPath(import.meta.url)), "FinanceiroAluno.jsx");
// Comentario nao conta: a explicacao da regra antiga nao pode passar pelo teste.
const codigo = readFileSync(FICHA, "utf8")
  .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

const aviso = (codigo.match(/window\.confirm\(\s*`(Cancelar esse acordo[^`]*)`/) || [])[1] || "";

describe("aviso do botao Cancelar acordo", () => {
  it("existe e vem antes da chamada a cancelar_acordo_ficha", () => {
    expect(aviso).not.toBe("");
    expect(codigo.indexOf("Cancelar esse acordo"))
      .toBeLessThan(codigo.indexOf('supabase.rpc("cancelar_acordo_ficha"'));
  });

  it("diz que as mensalidades voltam para em aberto e ficam livres para nova negociacao", () => {
    expect(aviso).toMatch(/voltam para em aberto/);
    expect(aviso).toMatch(/nova negociação/);
  });

  it("explica a excecao do saldo residual quando ha pagamento anterior na cadeia", () => {
    expect(aviso).toMatch(/acordo anterior que já recebeu pagamento continua negociada/);
    expect(aviso).toMatch(/saldo residual/);
  });

  it("nao repete a regra antiga", () => {
    expect(aviso).not.toMatch(/não voltam a ficar em aberto/);
    expect(aviso).not.toMatch(/continuam registradas como negociadas/);
  });
});

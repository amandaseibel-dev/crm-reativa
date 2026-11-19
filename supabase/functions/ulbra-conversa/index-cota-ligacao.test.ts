// Guarda estrutural: o handler (index.ts) SEMPRE fornece a reserva de cota ao caminho de histórico.
// Sem ela, historico-leitura.ts não reserva e a cota ficaria desligada sem erro. Não executa o handler
// (isso é do index-handler.test.ts); só confere que a ligação existe no código.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const INDEX = readFileSync(resolve(__dirname, "index.ts"), "utf8");

describe("ligação da cota no handler (estrutural)", () => {
  it("executarAcaoHistorico recebe reservarCota com a reserva real (ulbra_historico_reservar)", () => {
    expect(INDEX).toMatch(/reservarCota:\s*async\s*\(\)/);
    expect(INDEX).toMatch(/sb\.rpc\("ulbra_historico_reservar"/);
  });
  it("o teto inválido nega (função teto() devolve null e a reserva responde INDISPONIVEL)", () => {
    expect(INDEX).toMatch(/function teto\(/);
    expect(INDEX).toMatch(/tetoOperador === null \|\| tetoGlobal === null\) return "INDISPONIVEL"/);
  });
});

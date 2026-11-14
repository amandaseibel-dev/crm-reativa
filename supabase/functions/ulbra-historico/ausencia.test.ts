// Prova estatica: o modulo do historico NAO contem caminho de conexao, previa, envio ou OAuth.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const ARQUIVOS = ["index.ts", "historico.ts", "leitura.ts", "acesso.ts"];
const PROIBIDOS = ["conexao_", "envio_", "envioPrevia", "envioConfirmar", "conexaoIniciar", "oauth", "OAuth", "ULBRA_ENVIO_REAL", "ulbra-conversa", "ilike"];

describe("ulbra-historico: ausencia de OAuth e envio", () => {
  for (const f of ARQUIVOS) {
    it(`${f} nao contem termos de conexao, envio ou OAuth`, () => {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      for (const termo of PROIBIDOS) expect(src.includes(termo), `${f} contem ${termo}`).toBe(false);
    });
  }
});

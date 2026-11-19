// Flag JURIDICO_BLOQUEIO_ENVIO_ATIVO: desligada por padrão. Testes do helper e estruturais dos dois envios.
// O teste estrutural prova que a checagem fica DENTRO do if da flag; não executa o handler (Deno).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bloqueioJuridicoAtivo } from "./juridico-envio.ts";

const FUNCOES = resolve(__dirname, "..");
const LEITURA = (p: string) => readFileSync(resolve(FUNCOES, p), "utf8");
const CONDICAO = 'if (bloqueioJuridicoAtivo(Deno.env.get("JURIDICO_BLOQUEIO_ENVIO_ATIVO")))';

describe("bloqueioJuridicoAtivo", () => {
  it("ausente, vazia ou fora da lista = DESLIGADA", () => {
    expect(bloqueioJuridicoAtivo(undefined)).toBe(false);
    expect(bloqueioJuridicoAtivo("")).toBe(false);
    expect(bloqueioJuridicoAtivo("   ")).toBe(false);
    expect(bloqueioJuridicoAtivo("false")).toBe(false);
    expect(bloqueioJuridicoAtivo("0")).toBe(false);
    expect(bloqueioJuridicoAtivo("maybe")).toBe(false);
  });
  it("valor explícito = LIGADA", () => {
    expect(bloqueioJuridicoAtivo("true")).toBe(true);
    expect(bloqueioJuridicoAtivo("TRUE")).toBe(true);
    expect(bloqueioJuridicoAtivo(" sim ")).toBe(true);
  });
});

describe("envios: a checagem jurídica só é alcançada com a flag ligada (estrutural)", () => {
  for (const f of ["whatsapp-send/index.ts", "whatsapp-enviar-documento/index.ts"]) {
    it(`${f}: o if da flag existe e a checagem está dentro dele`, () => {
      const src = LEITURA(f);
      const iIf = src.indexOf(CONDICAO);
      const iChk = src.indexOf("checarEnvioJuridico((nome");
      expect(iIf).toBeGreaterThan(-1);
      expect(iChk).toBeGreaterThan(iIf);
      // o if é fechado depois da checagem: há uma chave de fechamento a seguir o bloco
      const fim = src.indexOf("\n  }\n", iChk);
      expect(fim).toBeGreaterThan(iChk);
    });
  }
});

// Máscara de CPF no servidor: mesmos critérios da interface, com dados FICTÍCIOS.
import { describe, it, expect } from "vitest";
import { mascararCpfEmTexto as mascaraServidor } from "./mascara-cpf.ts";
import { mascararCpfEmTexto as mascaraInterface } from "../../../src/utils/mascararCpf.js";

const CASOS: Array<[string, string]> = [
  ["meu CPF 529.982.247-25 pode conferir?", "meu CPF ***.***.***-25 pode conferir?"],
  ["cpf 52998224725 obrigada", "cpf ***.***.***-25 obrigada"],
  ["me liga no 11987654321", "me liga no 11987654321"],
  ["111.111.111-11 formatado inválido", "***.***.***-11 formatado inválido"],
  ["posso pagar amanhã?", "posso pagar amanhã?"],
];

describe("máscara de CPF no servidor (dados fictícios)", () => {
  for (const [entrada, esperado] of CASOS) {
    it(`"${entrada}" -> mesmo resultado da interface`, () => {
      expect(mascaraServidor(entrada)).toBe(esperado);
      expect(mascaraServidor(entrada)).toBe(mascaraInterface(entrada));
    });
  }
  it("entrada nula vira vazio", () => {
    expect(mascaraServidor(null)).toBe("");
  });
});

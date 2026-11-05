import { describe, it, expect } from "vitest";
import { validarNovaSenha, TAMANHO_MIN_SENHA, TAMANHO_MAX_SENHA } from "./senhaAdmin";

describe("validarNovaSenha", () => {
  it("aceita senha com letra, número e tamanho mínimo", () => {
    expect(validarNovaSenha("Reativa2026x").ok).toBe(true);
  });

  it("recusa senha curta", () => {
    expect(validarNovaSenha("abc123").ok).toBe(false);
  });

  it("recusa senha sem número ou sem letra", () => {
    expect(validarNovaSenha("apenasletrasmuito").ok).toBe(false);
    expect(validarNovaSenha("1234567890123").ok).toBe(false);
  });

  it("recusa espaço no começo ou no fim", () => {
    expect(validarNovaSenha(" Reativa2026x").ok).toBe(false);
    expect(validarNovaSenha("Reativa2026x ").ok).toBe(false);
  });

  it("recusa senha longa demais e valores que não são texto", () => {
    expect(validarNovaSenha("a1".repeat(TAMANHO_MAX_SENHA)).ok).toBe(false);
    expect(validarNovaSenha(undefined).ok).toBe(false);
    expect(validarNovaSenha(12345678901234).ok).toBe(false);
  });

  it("usa limites de 10 e 128 caracteres", () => {
    expect(TAMANHO_MIN_SENHA).toBe(10);
    expect(TAMANHO_MAX_SENHA).toBe(128);
  });
});

import { describe, it, expect } from "vitest";
import { emailNormalizado, unicoAtivo } from "./email_exato.ts";

describe("emailNormalizado", () => {
  it("normaliza espaços e caixa", () => {
    expect(emailNormalizado("  Amanda.Seibel@AELBRA.com.br ")).toBe("amanda.seibel@aelbra.com.br");
  });
  it("preserva caracteres especiais (sem interpretar padrão)", () => {
    expect(emailNormalizado("a_b%c*d\\e@x.com")).toBe("a_b%c*d\\e@x.com");
  });
  it("nulo vira vazio", () => {
    expect(emailNormalizado(null)).toBe("");
  });
});

describe("unicoAtivo", () => {
  it("aceita exatamente uma linha", () => {
    expect(unicoAtivo([{ perfil: "operador" }])).toEqual({ perfil: "operador" });
  });
  it("nega zero linhas", () => {
    expect(unicoAtivo([])).toBeNull();
    expect(unicoAtivo(null)).toBeNull();
  });
  it("nega duplicidade ativa (duas ou mais linhas)", () => {
    expect(unicoAtivo([{ perfil: "gerencia" }, { perfil: "operador" }])).toBeNull();
  });
});

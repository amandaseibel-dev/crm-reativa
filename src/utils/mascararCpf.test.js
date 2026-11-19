import { describe, it, expect } from "vitest";
import { mascararCpf, mascararCpfEmTexto } from "./mascararCpf";

describe("mascararCpf", () => {
  it("formatado ou só dígitos: mostra só os dois verificadores", () => {
    expect(mascararCpf("123.456.789-09")).toBe("***.***.***-09");
    expect(mascararCpf("12345678909")).toBe("***.***.***-09");
  });

  it("já mascarado no fim: não inventa dígito", () => {
    expect(mascararCpf("***.826.041-**")).toBe("***.***.***-**");
  });

  it("vazio vira travessão", () => {
    expect(mascararCpf(null)).toBe("—");
    expect(mascararCpf("")).toBe("—");
    expect(mascararCpf("   ")).toBe("—");
  });

  it("nunca devolve mais que os dois últimos dígitos", () => {
    for (const v of ["123.456.789-09", "12345678909", "456.789-09", "789"]) {
      const m = mascararCpf(v);
      expect(m.replace(/\D/g, "").length).toBeLessThanOrEqual(2);
    }
  });
});

// Texto livre (prévia). CPFs FICTÍCIOS com dígitos verificadores válidos.
describe("mascararCpfEmTexto (texto livre, dados fictícios)", () => {
  it("CPF com pontuação: mascara e preserva o restante", () => {
    expect(mascararCpfEmTexto("meu cpf é 529.982.247-25, pode ver?")).toBe("meu cpf é ***.***.***-25, pode ver?");
  });

  it("CPF só com dígitos (verificadores válidos): mascara", () => {
    expect(mascararCpfEmTexto("cpf 52998224725 obrigada")).toBe("cpf ***.***.***-25 obrigada");
  });

  it("número de 11 dígitos que não é CPF (telefone): NÃO é apagado", () => {
    expect(mascararCpfEmTexto("me liga no 11987654321")).toBe("me liga no 11987654321");
  });

  it("texto sem CPF fica igual; vazio vira vazio", () => {
    expect(mascararCpfEmTexto("posso pagar amanhã?")).toBe("posso pagar amanhã?");
    expect(mascararCpfEmTexto(null)).toBe("");
  });

  it("formatado com verificadores inválidos ainda é mascarado (padrão de CPF)", () => {
    expect(mascararCpfEmTexto("111.111.111-11")).toBe("***.***.***-11");
  });
});

import { describe, it, expect } from "vitest";
import { mascararCpf } from "./mascararCpf";

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

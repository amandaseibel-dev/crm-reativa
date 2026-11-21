import { describe, expect, it } from "vitest";
import { emailParaIlike } from "./ilike_email.ts";

describe("emailParaIlike", () => {
  it("e-mail comum passa sem alteração", () => {
    expect(emailParaIlike("ana@aelbra.com.br")).toBe("ana@aelbra.com.br");
  });
  it("_ e % são escapados (e-mail legítimo com _ continua casando exatamente)", () => {
    expect(emailParaIlike("ana_maria@x.com")).toBe("ana\\_maria@x.com");
    expect(emailParaIlike("a%b@x.com")).toBe("a\\%b@x.com");
  });
  it("barra invertida é escapada", () => {
    expect(emailParaIlike("a\\b@x.com")).toBe("a\\\\b@x.com");
  });
  it("* é recusado (curinga do PostgREST): devolve null", () => {
    expect(emailParaIlike("a*b@x.com")).toBeNull();
    expect(emailParaIlike("*@x.com")).toBeNull();
  });
});

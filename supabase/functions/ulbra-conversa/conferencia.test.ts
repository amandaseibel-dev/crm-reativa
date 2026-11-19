import { describe, expect, it } from "vitest";
import { PERFIS_CONFERENCIA, podeConferir } from "./conferencia.ts";

// Perfis de gestão permitidos a conferir envio.
describe("perfis que podem conferir envio", () => {
  it.each(["supervisor", "gerencia", "administrativo"])("%s pode conferir", (perfil) => {
    expect(podeConferir(perfil)).toBe(true);
  });
  it.each(["operador", "auditor", "", " supervisor", "Supervisor", "supervisor ", "gerente", "admin"])("'%s' NÃO pode conferir", (perfil) => {
    expect(podeConferir(perfil)).toBe(false);
  });
  it.each([null, undefined, 0, false, {}, ["supervisor"]])("valor não textual %j NÃO pode conferir", (perfil) => {
    expect(podeConferir(perfil)).toBe(false);
  });
  it("a lista é exatamente a da gestão, sem curinga", () => {
    expect([...PERFIS_CONFERENCIA].sort()).toEqual(["administrativo", "gerencia", "supervisor"]);
  });
});

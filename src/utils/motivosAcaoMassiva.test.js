// Os motivos novos do A7 precisam de rotulo pt-BR: `rotuloMotivo` cai no
// codigo cru quando o motivo nao esta no mapa, e codigo cru na tela e o que a
// operacao le como erro.
import { describe, it, expect } from "vitest";
import { rotuloMotivo } from "./motivosAcaoMassiva";

describe("rotuloMotivo", () => {
  it("traduz os motivos do A7 sem expor o contato", () => {
    const compartilhado = rotuloMotivo("contato_compartilhado");
    const invalidado = rotuloMotivo("contato_invalidado");
    expect(compartilhado).toBe("Outra pessoa com dívida usa o mesmo contato");
    expect(invalidado).toBe("Contato marcado como incorreto");
    // nao vaza telefone/e-mail nem devolve o codigo cru
    for (const t of [compartilhado, invalidado]) {
      expect(t).not.toMatch(/@|\d{8,}/);
      expect(t).not.toMatch(/^contato_/);
    }
  });

  it("mantem os motivos que ja existiam", () => {
    expect(rotuloMotivo("retorno_futuro")).toBe("Retorno futuro");
    expect(rotuloMotivo("contato_indisponivel")).toBe("Sem contato válido para o canal");
  });

  it("motivo desconhecido volta como veio, sem quebrar", () => {
    expect(rotuloMotivo("coisa_nova")).toBe("coisa_nova");
    expect(rotuloMotivo(undefined)).toBe(undefined);
  });
});

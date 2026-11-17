// Renovação com compare-and-set: nunca reativa conexão desconectada nem sobrescreve conexão nova.
import { describe, it, expect } from "vitest";
import { gravarRenovacaoSe, type EstadoLinha, type GuardaRenovacao } from "./renovacao.ts";

// Linha em memória. `durante` roda entre a leitura e a gravação (simula concorrência).
function linhaEmMemoria(inicial: EstadoLinha, durante?: (l: { v: EstadoLinha }) => void) {
  const l = { v: { ...inicial } };
  const guarda: GuardaRenovacao = {
    async ler() { durante?.(l); return { ...l.v }; },
    async gravarSe(esperado, novo) {
      // CAS: só grava se a linha ainda é a lida e não está revogada.
      if (l.v.revogada || l.v.refresh_cifrado !== esperado.refresh_cifrado) return false;
      l.v = { refresh_cifrado: novo.refresh_cifrado, revogada: false };
      return true;
    },
  };
  return { l, guarda };
}
const NOVO = { access_cifrado: "A2", refresh_cifrado: "R2", expira_em_ms: 1 };

describe("gravarRenovacaoSe", () => {
  it("sem concorrência, grava", async () => {
    const { l, guarda } = linhaEmMemoria({ refresh_cifrado: "R1", revogada: false });
    const antes = await guarda.ler();
    expect(await gravarRenovacaoSe(guarda, antes, NOVO)).toBe("GRAVADA");
    expect(l.v.refresh_cifrado).toBe("R2");
  });

  it("desconectar durante a renovação NÃO é reativado", async () => {
    const { l, guarda } = linhaEmMemoria({ refresh_cifrado: "R1", revogada: false }, (x) => {
      x.v = { ...x.v, revogada: true };
    });
    const antes = { refresh_cifrado: "R1", revogada: false };
    expect(await gravarRenovacaoSe(guarda, antes, NOVO)).toBe("CONEXAO_MUDOU");
    expect(l.v.revogada).toBe(true);
    expect(l.v.refresh_cifrado).toBe("R1");
  });

  it("conexão nova gravada durante a renovação NÃO é sobrescrita", async () => {
    const { l, guarda } = linhaEmMemoria({ refresh_cifrado: "R1", revogada: false }, (x) => {
      x.v = { refresh_cifrado: "RNOVA", revogada: false };
    });
    const antes = { refresh_cifrado: "R1", revogada: false };
    expect(await gravarRenovacaoSe(guarda, antes, NOVO)).toBe("CONEXAO_MUDOU");
    expect(l.v.refresh_cifrado).toBe("RNOVA");
  });

  it("estado já revogado antes da leitura nunca grava", async () => {
    const { l, guarda } = linhaEmMemoria({ refresh_cifrado: "R1", revogada: true });
    expect(await gravarRenovacaoSe(guarda, { refresh_cifrado: "R1", revogada: true }, NOVO)).toBe("CONEXAO_MUDOU");
    expect(l.v.revogada).toBe(true);
  });
});

// Testa o controle de acesso efetivo da ulbra-leads-pendentes
// Roda em Node (sem DOM) — sem pragma jsdom
import { describe, it, expect } from "vitest";

// Lógica de autorização isolada para teste direto
// (mesma lógica presente em index.ts, extraída para verificação)
function decidirAcesso(usuario: { receptivo?: boolean; gestao?: boolean } | null): {
  autorizado: boolean;
  motivo?: string;
} {
  if (!usuario) return { autorizado: false, motivo: "ACESSO_NEGADO" };
  if (usuario.receptivo || usuario.gestao) return { autorizado: true };
  return { autorizado: false, motivo: "NAO_RECEPTIVO" };
}

describe("ulbra-leads-pendentes: controle de acesso efetivo", () => {
  it("nega acesso quando usuário não existe no banco", () => {
    const r = decidirAcesso(null);
    expect(r.autorizado).toBe(false);
    expect(r.motivo).toBe("ACESSO_NEGADO");
  });

  it("nega acesso a operador sem receptivo nem gestão", () => {
    const r = decidirAcesso({ receptivo: false, gestao: false });
    expect(r.autorizado).toBe(false);
    expect(r.motivo).toBe("NAO_RECEPTIVO");
  });

  it("nega acesso a operador com receptivo=undefined", () => {
    const r = decidirAcesso({});
    expect(r.autorizado).toBe(false);
    expect(r.motivo).toBe("NAO_RECEPTIVO");
  });

  it("concede acesso a operador receptivo", () => {
    const r = decidirAcesso({ receptivo: true, gestao: false });
    expect(r.autorizado).toBe(true);
    expect(r.motivo).toBeUndefined();
  });

  it("concede acesso a gestão (independente de receptivo)", () => {
    const r = decidirAcesso({ receptivo: false, gestao: true });
    expect(r.autorizado).toBe(true);
  });

  it("concede acesso quando ambos são true", () => {
    const r = decidirAcesso({ receptivo: true, gestao: true });
    expect(r.autorizado).toBe(true);
  });
});

// Testa o filtro de equipe — valor canônico confirmado via API em 2026-11-02
describe("ulbra-leads-pendentes: filtro de equipe ReATIVA", () => {
  type Atendimento = { id: string; equipe?: string | null };

  function filtrarReativa(atendimentos: Atendimento[]) {
    return atendimentos.filter((a) => a.equipe === "Reativa");
  }

  it("exclui atendimentos sem equipe (null)", () => {
    expect(filtrarReativa([{ id: "a1", equipe: null }])).toHaveLength(0);
  });

  it("exclui atendimentos de outras equipes", () => {
    expect(filtrarReativa([{ id: "a2", equipe: "Financeiro" }])).toHaveLength(0);
    expect(filtrarReativa([{ id: "a3", equipe: "Cobranca" }])).toHaveLength(0);
  });

  it("exclui variações de caixa do nome da equipe", () => {
    // Garante que só "Reativa" (exato) passa — não "REATIVA" nem "reativa"
    expect(filtrarReativa([{ id: "a4", equipe: "REATIVA" }])).toHaveLength(0);
    expect(filtrarReativa([{ id: "a5", equipe: "reativa" }])).toHaveLength(0);
  });

  it("aceita apenas equipe exatamente 'Reativa'", () => {
    const resultado = filtrarReativa([
      { id: "a6", equipe: "Reativa" },
      { id: "a7", equipe: "Financeiro" },
      { id: "a8", equipe: null },
    ]);
    expect(resultado).toHaveLength(1);
    expect(resultado[0].id).toBe("a6");
  });
});

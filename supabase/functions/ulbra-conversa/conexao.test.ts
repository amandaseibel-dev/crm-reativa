// Conexão individual: estados, renovação, falha de renovação e desconexão.
// PROVA SIMULADA: o provedor é `ProvedorSimulado`, não a ULBRA. Nada aqui é
// integração validada com a Mensageria.
import { describe, it, expect } from "vitest";
import {
  MARGEM_MS,
  conexaoUtilizavel,
  desconectar,
  estadoConexao,
  garantirConexao,
  type ProvedorOAuth,
  type RegistroConexao,
} from "./conexao.ts";

const AGORA = Date.parse("2026-11-09T12:00:00Z");

const base = (over: Partial<RegistroConexao> = {}): RegistroConexao => ({
  operador_email: "cobranca10@aelbra.com.br",
  access_token: "acc-1",
  refresh_token: "ref-1",
  expira_em_ms: AGORA + 60 * 60 * 1000,
  revogada_em_ms: null,
  ...over,
});

class ProvedorSimulado implements ProvedorOAuth {
  renovacoes: string[] = [];
  revogacoes: string[] = [];
  falharRenovacao = false;
  falharRevogacao = false;
  async renovar(refresh: string) {
    this.renovacoes.push(refresh);
    if (this.falharRenovacao) throw new Error("ERRO_SIMULADO_RENOVACAO");
    return { access_token: "acc-2", refresh_token: "ref-2", expira_em_ms: AGORA + 60 * 60 * 1000 };
  }
  async revogar(token: string) {
    this.revogacoes.push(token);
    if (this.falharRevogacao) throw new Error("ERRO_SIMULADO_REVOGACAO");
  }
}

describe("estado da conexão", () => {
  it("sem registro: SEM_CONEXAO e bloqueado", () => {
    expect(estadoConexao(null, AGORA)).toBe("SEM_CONEXAO");
    expect(conexaoUtilizavel("SEM_CONEXAO")).toBe(false);
  });

  it("token longe do vencimento: ATIVA", () => {
    expect(estadoConexao(base(), AGORA)).toBe("ATIVA");
  });

  it("dentro da margem com refresh: EXPIRANDO, ainda utilizável após renovação", () => {
    const r = base({ expira_em_ms: AGORA + MARGEM_MS - 1 });
    expect(estadoConexao(r, AGORA)).toBe("EXPIRANDO");
    expect(conexaoUtilizavel("EXPIRANDO")).toBe(true);
  });

  it("vencido sem refresh: EXPIRADA e bloqueado", () => {
    const r = base({ refresh_token: null, expira_em_ms: AGORA - 1 });
    expect(estadoConexao(r, AGORA)).toBe("EXPIRADA");
    expect(conexaoUtilizavel("EXPIRADA")).toBe(false);
  });

  it("revogada: REVOGADA mesmo com token válido", () => {
    expect(estadoConexao(base({ revogada_em_ms: AGORA - 1 }), AGORA)).toBe("REVOGADA");
  });
});

describe("renovação", () => {
  it("ATIVA não chama o provedor", async () => {
    const p = new ProvedorSimulado();
    const r = await garantirConexao(base(), p, AGORA);
    expect(r.ok).toBe(true);
    expect(p.renovacoes).toEqual([]);
  });

  it("EXPIRANDO renova e ROTACIONA o refresh token", async () => {
    const p = new ProvedorSimulado();
    const r = await garantirConexao(base({ expira_em_ms: AGORA + 1000 }), p, AGORA);
    expect(p.renovacoes).toEqual(["ref-1"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.registro.access_token).toBe("acc-2");
      expect(r.registro.refresh_token).toBe("ref-2");
    }
  });

  it("falha de renovação vira EXPIRADA e bloqueia: nunca reaproveita token vencido", async () => {
    const p = new ProvedorSimulado();
    p.falharRenovacao = true;
    const r = await garantirConexao(base({ expira_em_ms: AGORA + 1000 }), p, AGORA);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.estado).toBe("EXPIRADA");
      expect(r.motivo).toContain("RENOVACAO_FALHOU");
    }
  });

  it("sem registro não consulta provedor", async () => {
    const p = new ProvedorSimulado();
    const r = await garantirConexao(null, p, AGORA);
    expect(r.ok).toBe(false);
    expect(p.renovacoes).toEqual([]);
  });
});

describe("desconexão", () => {
  it("revoga no provedor e marca local como revogada", async () => {
    const p = new ProvedorSimulado();
    const out = await desconectar(base(), p, AGORA);
    expect(out.revogada_no_provedor).toBe(true);
    expect(out.registro.revogada_em_ms).toBe(AGORA);
    expect(estadoConexao(out.registro, AGORA)).toBe("REVOGADA");
  });

  it("falha do provedor ainda bloqueia o envio localmente, e fica sinalizada", async () => {
    const p = new ProvedorSimulado();
    p.falharRevogacao = true;
    const out = await desconectar(base(), p, AGORA);
    expect(out.revogada_no_provedor).toBe(false);
    expect(estadoConexao(out.registro, AGORA)).toBe("REVOGADA");
  });
});

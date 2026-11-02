// Testa o controle de acesso efetivo da ulbra-consultar.
// Roda em Node (sem DOM) — sem pragma jsdom.
import { describe, it, expect } from "vitest";
import { decidirAcessoUlbra, PERFIS_AMPLOS } from "./portao.ts";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeEntrada(overrides: Partial<Parameters<typeof decidirAcessoUlbra>[0]>) {
  return {
    autorizacao: "Bearer tok-valido",
    aluno_id: "aluno-abc",
    validarOperador: async () => ({ email: "op@aelbra.com.br", perfil: "operador" }),
    verificarEscopoAluno: async () => true,
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Autenticação de gateway (header)
// --------------------------------------------------------------------------

describe("ulbra-consultar portão: autenticação", () => {
  it("nega quando não há header Authorization", async () => {
    const r = await decidirAcessoUlbra(makeEntrada({ autorizacao: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect((r.corpo as Record<string, unknown>).erro).toBe("SEM_TOKEN");
    }
  });

  it("nega quando Authorization não começa com 'Bearer '", async () => {
    const r = await decidirAcessoUlbra(makeEntrada({ autorizacao: "Basic abc123" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("nega quando operador não existe em usuarios", async () => {
    const r = await decidirAcessoUlbra(makeEntrada({
      validarOperador: async () => null,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect((r.corpo as Record<string, unknown>).erro).toBe("ACESSO_NEGADO");
    }
  });

  it("nega quando validarOperador lança exceção", async () => {
    const r = await decidirAcessoUlbra(makeEntrada({
      validarOperador: async () => { throw new Error("timeout"); },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});

// --------------------------------------------------------------------------
// Autorização de escopo: operador comum
// --------------------------------------------------------------------------

describe("ulbra-consultar portão: escopo do operador", () => {
  it("autoriza operador cujo aluno está na carteira", async () => {
    const r = await decidirAcessoUlbra(makeEntrada({
      validarOperador: async () => ({ email: "op@aelbra.com.br", perfil: "operador" }),
      verificarEscopoAluno: async () => true,
    }));
    expect(r.ok).toBe(true);
  });

  it("nega operador quando aluno está fora da carteira", async () => {
    const r = await decidirAcessoUlbra(makeEntrada({
      validarOperador: async () => ({ email: "op@aelbra.com.br", perfil: "operador" }),
      verificarEscopoAluno: async () => false,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect((r.corpo as Record<string, unknown>).detalhe).toBe("aluno_fora_da_carteira");
    }
  });

  it("nega quando verificarEscopoAluno lança exceção (falha fechada)", async () => {
    const r = await decidirAcessoUlbra(makeEntrada({
      validarOperador: async () => ({ email: "op@aelbra.com.br", perfil: "operador" }),
      verificarEscopoAluno: async () => { throw new Error("db error"); },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("não chama verificarEscopoAluno para perfis amplos", async () => {
    let chamado = false;
    const r = await decidirAcessoUlbra(makeEntrada({
      validarOperador: async () => ({ email: "gestao@aelbra.com.br", perfil: "gerencia" }),
      verificarEscopoAluno: async () => { chamado = true; return false; },
    }));
    expect(r.ok).toBe(true);
    expect(chamado).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Autorização de escopo: perfis amplos
// --------------------------------------------------------------------------

describe("ulbra-consultar portão: perfis com acesso amplo", () => {
  for (const perfil of PERFIS_AMPLOS) {
    it(`autoriza perfil '${perfil}' sem checar carteira`, async () => {
      const r = await decidirAcessoUlbra(makeEntrada({
        validarOperador: async () => ({ email: "gestor@aelbra.com.br", perfil }),
        verificarEscopoAluno: async () => false, // retorna false mas não deve ser chamado
      }));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.usuario.perfil).toBe(perfil);
    });
  }
});

// --------------------------------------------------------------------------
// Resultado da decisão: campos retornados
// --------------------------------------------------------------------------

describe("ulbra-consultar portão: resultado da decisão", () => {
  it("decisão ok carrega email e perfil do usuário", async () => {
    const r = await decidirAcessoUlbra(makeEntrada({
      validarOperador: async () => ({ email: "op@aelbra.com.br", perfil: "operador" }),
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.usuario.email).toBe("op@aelbra.com.br");
      expect(r.usuario.perfil).toBe("operador");
    }
  });

  it("decisão negada não expõe dados do aluno nem do vínculo", async () => {
    const r = await decidirAcessoUlbra(makeEntrada({
      validarOperador: async () => ({ email: "op@aelbra.com.br", perfil: "operador" }),
      verificarEscopoAluno: async () => false,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const corpo = r.corpo as Record<string, unknown>;
      // Garante que nenhuma informação do aluno vazou na resposta de negação
      expect(corpo).not.toHaveProperty("aluno_id");
      expect(corpo).not.toHaveProperty("telefone");
      expect(corpo).not.toHaveProperty("cpf");
      expect(corpo).not.toHaveProperty("ulbra_cliente_id");
    }
  });
});

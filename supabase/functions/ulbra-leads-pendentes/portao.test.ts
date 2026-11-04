// Testa o portão real da ulbra-leads-pendentes (importado, não copiado) e o
// contrato de listar_atendimentos com a forma medida em 2026-11-04.
import { describe, it, expect } from "vitest";
import { decidirAcessoLeads } from "./portao.ts";
import { extrairResultado, mapearLeads, montarChamada } from "./leads.ts";

function entrada(overrides: Partial<Parameters<typeof decidirAcessoLeads>[0]>) {
  return {
    autorizacao: "Bearer tok",
    obterUsuario: async () => ({ receptivo: true, gestao: false }),
    ...overrides,
  };
}

describe("ulbra-leads-pendentes portão", () => {
  it("nega sem Bearer", async () => {
    const r = await decidirAcessoLeads(entrada({ autorizacao: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("nega quando a identidade do token não está em usuarios", async () => {
    const r = await decidirAcessoLeads(entrada({ obterUsuario: async () => null }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.corpo.erro).toBe("ACESSO_NEGADO");
    }
  });

  it("falha fechado quando obterUsuario lança", async () => {
    const r = await decidirAcessoLeads(entrada({ obterUsuario: async () => { throw new Error("db"); } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("operador sem receptivo e sem gestão recebe lista vazia com NAO_RECEPTIVO", async () => {
    const r = await decidirAcessoLeads(entrada({ obterUsuario: async () => ({ receptivo: false, gestao: false }) }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(200);
      expect(r.corpo).toEqual({ leads: [], motivo: "NAO_RECEPTIVO" });
    }
  });

  it("receptivo autoriza", async () => {
    expect((await decidirAcessoLeads(entrada({}))).ok).toBe(true);
  });

  it("gestão (usuario_e_gestao) autoriza mesmo sem receptivo", async () => {
    const r = await decidirAcessoLeads(entrada({ obterUsuario: async () => ({ receptivo: false, gestao: true }) }));
    expect(r.ok).toBe(true);
  });

  it("o portão recebe a autorização do pedido, não outra", async () => {
    let recebido = "";
    await decidirAcessoLeads(entrada({ autorizacao: "Bearer abc", obterUsuario: async (a) => { recebido = a; return null; } }));
    expect(recebido).toBe("Bearer abc");
  });
});

const RESPOSTA_REAL = {
  atendimentos: [
    { id: "6aeb108cb0d037965ad8a42c", cliente: { id: "6aba860a7f82c11af188c732", nome: "Cliente Um" }, situacao: "waiting", coluna: null, equipe: "Reativa", atendente: null, entrouEm: "2026-11-04T11:01:32.598Z", aceitoEm: null, atualizadoEm: "2026-11-04T11:01:32.598Z" },
    { id: "6ab18f359be689ab72d973ea", cliente: { id: "691dd4ad5dbe7b715b96c8ee", nome: "Cliente Dois" }, situacao: "waiting", coluna: "contacted", equipe: "Financeiro", atendente: "Alguém", entrouEm: "2026-09-21T20:10:29.891Z", aceitoEm: null, atualizadoEm: "2026-11-04T11:00:50.253Z" },
    { id: "6aeb0cbab0d037965ad4cf8a", cliente: { id: "691dd1a55dbe7b715b95bbd0", nome: null }, situacao: "waiting", coluna: null, equipe: "Reativa", atendente: null, entrouEm: null, aceitoEm: null, atualizadoEm: "2026-11-04T10:45:14.275Z" },
    { id: "6aeb0ae54b81fbe42a6271d8", cliente: { id: "x", nome: "Fora" }, situacao: "waiting", coluna: null, equipe: null, atendente: null, entrouEm: "2026-11-04T10:37:25.063Z", aceitoEm: null, atualizadoEm: "2026-11-04T10:37:25.063Z" },
  ],
  paginacao: { pagina: 1, limite: 50, total: 4 },
  chamada: "6aeb119db0d037965ad8b583",
};

describe("ulbra-leads-pendentes contrato: listar_atendimentos", () => {
  it("pede situacao=waiting pela ferramenta certa", () => {
    const c = montarChamada();
    expect(c.params.name).toBe("listar_atendimentos");
    expect(c.params.arguments).toEqual({ situacao: "waiting" });
  });

  it("lê entrouEm (não criadoEm) e cai para atualizadoEm", () => {
    const leads = mapearLeads(RESPOSTA_REAL);
    expect(leads.map((l) => l.id)).toEqual(["6aeb108cb0d037965ad8a42c", "6aeb0cbab0d037965ad4cf8a"]);
    expect(leads[0].criado_em).toBe("2026-11-04T11:01:32.598Z");
    expect(leads[1].criado_em).toBe("2026-11-04T10:45:14.275Z");
    expect(leads[1].nome).toBe("Sem nome");
  });

  it("só equipe exatamente 'Reativa'", () => {
    const leads = mapearLeads({ atendimentos: [
      { id: "a", equipe: "REATIVA" }, { id: "b", equipe: "reativa" }, { id: "c", equipe: null }, { id: "d", equipe: "Reativa" },
    ] });
    expect(leads.map((l) => l.id)).toEqual(["d"]);
  });

  it("não expõe telefone, e-mail, CPF nem o id do cliente", () => {
    for (const l of mapearLeads(RESPOSTA_REAL)) {
      expect(Object.keys(l).sort()).toEqual(["criado_em", "id", "nome"]);
    }
  });

  it("resposta sem atendimentos[] vira lista vazia", () => {
    expect(mapearLeads({})).toEqual([]);
    expect(mapearLeads(null)).toEqual([]);
  });

  it("envelope com error falha fechado", () => {
    expect(() => extrairResultado({ error: { message: "rate limit" } })).toThrow(/MCP_ERRO/);
  });

  it("extrai o resultado do envelope JSON-RPC", () => {
    const env = { result: { content: [{ type: "text", text: JSON.stringify(RESPOSTA_REAL) }] } };
    expect(mapearLeads(extrairResultado(env))).toHaveLength(2);
  });
});

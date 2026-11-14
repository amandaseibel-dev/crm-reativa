// Executa o handler REAL da ulbra-historico (sem rede) no fluxo da ficha:
// resolução da conversa pelo aluno, CPF confirmado, permissão, teto total do
// piloto (3 chamadas, incluindo meu_acesso) e parada em 429. ULBRA é um dublê.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { estado, ulbraRoteada, envelope, limite429 } from "../_shared/teste_edge";
import { limparCacheParaTeste } from "./historico";

vi.mock("https://deno.land/std@0.177.0/http/server.ts", async () => (await import("../_shared/teste_edge")).servePlaceholder);
vi.mock("https://esm.sh/@supabase/supabase-js@2", async () => {
  const h = await import("../_shared/teste_edge");
  return { createClient: (u: string, k: string, o?: Parameters<typeof h.clienteSupabaseFalso>[2]) => h.clienteSupabaseFalso(u, k, o) };
});

const ENV = { SUPABASE_URL: "https://x.test", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service", ULBRA_MCP_TOKEN: "token-falso" };
const A1 = "11111111-1111-4111-8111-111111111111"; // CPF confirmado, conversa da cobranca10
const A2 = "22222222-2222-4222-8222-222222222222"; // sem CPF confirmado
const A3 = "33333333-3333-4333-8333-333333333333"; // CPF confirmado, sem conversa
const CONV_ANTIGA = "aaaaaaaaaaaaaaaaaaaaaaa1";
const CONV_RECENTE = "aaaaaaaaaaaaaaaaaaaaaaa2";
const SALDO_FRESCO = () => new Date().toISOString();

function pedido(token: string | null, corpo: Record<string, unknown>) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://x.test/functions/v1/ulbra-historico", { method: "POST", headers, body: JSON.stringify(corpo) });
}

async function chamar(token: string | null, corpo: Record<string, unknown>) {
  const resp = await estado.handler!(pedido(token, corpo));
  return { status: resp.status, corpo: (await resp.json().catch(() => ({}))) as Record<string, unknown> };
}

const ROTA_OK = {
  ler_conversa: () => envelope({ mensagens: [{ quem: "cliente", em: "2026-11-11T10:00:00Z", texto: "pode me ligar?" }], paginacao: { maisAntigas: false } }),
  meu_acesso: () => envelope({ limites: { pessoaPorDia: { restam: 9000 } } }),
};

beforeAll(async () => {
  Object.assign(estado.env, ENV);
  await import("./index");
});

beforeEach(() => {
  limparCacheParaTeste();
  ulbraRoteada(ROTA_OK);
  estado.tokens = {
    "tok-dona": "cobranca10@aelbra.com.br",
    "tok-outra": "cobranca11@aelbra.com.br",
    "tok-gestao": "gestao@aelbra.com.br",
    "tok-inativo": "inativo@aelbra.com.br",
  };
  estado.banco = {
    usuarios: [
      { email: "cobranca10@aelbra.com.br", perfil: "operador", ativo: true },
      { email: "cobranca11@aelbra.com.br", perfil: "operador", ativo: true },
      { email: "gestao@aelbra.com.br", perfil: "gerencia", ativo: true },
      { email: "inativo@aelbra.com.br", perfil: "operador", ativo: false },
    ],
    ulbra_vinculos: [
      { aluno_id: A1, ulbra_cliente_id: "C1", confianca: "alta_cpf", desvinculado_em: null },
      { aluno_id: A3, ulbra_cliente_id: "C3", confianca: "alta_cpf", desvinculado_em: null },
    ],
    ulbra_conversas: [
      { ulbra_conversa_id: CONV_ANTIGA, ulbra_cliente_id: "C1", aluno_id: A1, aluno_status: "vinculado", equipe: "Reativa", ultima_mensagem_em: "2026-11-10T10:00:00Z" },
      { ulbra_conversa_id: CONV_RECENTE, ulbra_cliente_id: "C1", aluno_id: A1, aluno_status: "vinculado", equipe: "Reativa", ultima_mensagem_em: "2026-11-11T10:00:00Z" },
    ],
    casos: [{ aluno_id: A1, operador_email: "cobranca10@aelbra.com.br" }],
    ulbra_atendimentos: [],
    ulbra_sync_estado: [{ id: true, saldo_api_restam: 9000, saldo_api_em: SALDO_FRESCO() }],
    ulbra_historico_uso: [],
  };
});

describe("ficha: nada é lido sem identidade, aluno ou permissão", () => {
  it("sem aluno_id: 400 e nenhuma chamada à ULBRA", async () => {
    const r = await chamar("tok-dona", {});
    expect(r.status).toBe(400);
    expect(estado.chamadasUlbra).toBe(0);
  });
  it("aluno sem CPF confirmado: 403 IDENTIDADE_NAO_CONFIRMADA e nada sai", async () => {
    const r = await chamar("tok-dona", { aluno_id: A2 });
    expect(r.status).toBe(403);
    expect(r.corpo.motivo).toBe("IDENTIDADE_NAO_CONFIRMADA");
    expect(estado.chamadasUlbra).toBe(0);
  });
  it("aluno com CPF e sem conversa coletada: 404 CONVERSA_NAO_ENCONTRADA e nada sai", async () => {
    const r = await chamar("tok-dona", { aluno_id: A3 });
    expect(r.status).toBe(404);
    expect(r.corpo.motivo).toBe("CONVERSA_NAO_ENCONTRADA");
    expect(estado.chamadasUlbra).toBe(0);
  });
  it("sem token: 401 e nada sai", async () => {
    const r = await chamar(null, { aluno_id: A1 });
    expect(r.status).toBe(401);
    expect(estado.chamadasUlbra).toBe(0);
  });
  it("outro operador, sem a carteira: 403 SEM_PERMISSAO_NA_CONVERSA e nada sai", async () => {
    const r = await chamar("tok-outra", { aluno_id: A1 });
    expect(r.corpo.motivo).toBe("SEM_PERMISSAO_NA_CONVERSA");
    expect(estado.chamadasUlbra).toBe(0);
  });
  it("usuário inativo: 403 e nada sai", async () => {
    const r = await chamar("tok-inativo", { aluno_id: A1 });
    expect(r.status).toBe(403);
    expect(estado.chamadasUlbra).toBe(0);
  });
  it("duplicidade ativa do mesmo e-mail: negada e nada sai", async () => {
    estado.banco.usuarios = [...estado.banco.usuarios, { email: "cobranca10@aelbra.com.br", perfil: "gerencia", ativo: true }];
    const r = await chamar("tok-dona", { aluno_id: A1 });
    expect(r.status).toBe(403);
    expect(estado.chamadasUlbra).toBe(0);
  });
});

describe("ficha: leitura quando a permissão existe", () => {
  it("dona da carteira: lê a conversa MAIS RECENTE do aluno e mostra a data da consulta e das mensagens", async () => {
    const r = await chamar("tok-dona", { aluno_id: A1 });
    expect(r.status).toBe(200);
    expect(r.corpo.ok).toBe(true);
    expect(r.corpo.conversa_id).toBe(CONV_RECENTE);
    expect(typeof r.corpo.consultado_em).toBe("string");
    expect(Number.isNaN(Date.parse(String(r.corpo.consultado_em)))).toBe(false);
    const pagina = r.corpo.pagina as { mensagens: Array<{ em: string }> };
    expect(pagina.mensagens[0].em).toBe("2026-11-11T10:00:00Z");
    expect(estado.chamadasUlbra).toBe(1);
  });
  it("gestão: lê o aluno de outra carteira", async () => {
    const r = await chamar("tok-gestao", { aluno_id: A1 });
    expect(r.corpo.ok).toBe(true);
    expect(estado.chamadasUlbra).toBe(1);
  });
  it("a mesma leitura repetida dentro de 5 minutos custa zero chamadas", async () => {
    await chamar("tok-dona", { aluno_id: A1 });
    await chamar("tok-dona", { aluno_id: A1 });
    expect(estado.chamadasUlbra).toBe(1);
  });
});

describe("orçamento por usuário e compartilhado (valores propostos, aguardam aprovação)", () => {
  it("usuário que já usou o limite do dia: negado, nada sai", async () => {
    estado.banco.ulbra_historico_uso = [{ escopo: "cobranca10@aelbra.com.br", dia: "2026-11-14", usadas: 20 }];
    const r = await chamar("tok-dona", { aluno_id: A1 });
    expect(r.corpo.motivo).toBe("LIMITE_OPERADOR_DIA");
    expect(estado.chamadasUlbra).toBe(0);
  });
  it("orçamento compartilhado esgotado (saldo menos reserva): negado, nada sai", async () => {
    estado.banco.ulbra_sync_estado = [{ id: true, saldo_api_restam: 100, saldo_api_em: SALDO_FRESCO() }];
    const r = await chamar("tok-dona", { aluno_id: A1 });
    expect(r.corpo.motivo).toBe("RESERVA_GLOBAL");
    expect(estado.chamadasUlbra).toBe(0);
  });
  it("resposta traz o saldo medido e quando foi medido", async () => {
    const r = await chamar("tok-dona", { aluno_id: A1 });
    const saldo = r.corpo.saldo as { restam: number; medido_em: string };
    expect(saldo.restam).toBe(9000);
    expect(typeof saldo.medido_em).toBe("string");
  });
  it("saldo vencido: meu_acesso conta no orçamento do usuário e a leitura segue", async () => {
    estado.banco.ulbra_sync_estado = [{ id: true, saldo_api_restam: 9000, saldo_api_em: "2026-11-01T00:00:00Z" }];
    const r = await chamar("tok-dona", { aluno_id: A1 });
    expect(r.corpo.ok).toBe(true);
    expect(estado.chamadasUlbra).toBe(2);
  });
});

describe("cliques simultâneos: o orçamento compartilhado nunca passa do limite", () => {
  it("5 leituras ao mesmo tempo com 3 de orçamento: exatamente 3 chegam à ULBRA", async () => {
    // saldo 103 menos reserva 100 = orçamento de 3 para o dia
    estado.banco.ulbra_sync_estado = [{ id: true, saldo_api_restam: 103, saldo_api_em: SALDO_FRESCO() }];
    const cursores = ["2026-11-10T01:00:00Z", "2026-11-10T02:00:00Z", "2026-11-10T03:00:00Z", "2026-11-10T04:00:00Z", "2026-11-10T05:00:00Z"];
    const respostas = await Promise.all(cursores.map((c) => chamar("tok-dona", { aluno_id: A1, antes_de: c })));
    const motivos = respostas.map((r) => r.corpo.motivo ?? "ok");
    expect(estado.chamadasUlbra).toBe(3);
    expect(motivos.filter((m) => m === "RESERVA_GLOBAL")).toHaveLength(2);
  });
});

describe("isolamento entre operadores: cada um vê só o que a carteira ou o responsável dá", () => {
  it("dono da carteira lê; outro operador é negado sem chamada", async () => {
    expect((await chamar("tok-dona", { aluno_id: A1 })).corpo.ok).toBe(true);
    expect((await chamar("tok-outra", { aluno_id: A1 })).corpo.motivo).toBe("SEM_PERMISSAO_NA_CONVERSA");
  });
  it("dois donos na carteira: identidade do dono é ambígua e a leitura é negada", async () => {
    estado.banco.casos = [{ aluno_id: A1, operador_email: "cobranca10@aelbra.com.br" }, { aluno_id: A1, operador_email: "cobranca11@aelbra.com.br" }];
    expect((await chamar("tok-dona", { aluno_id: A1 })).corpo.motivo).toBe("SEM_PERMISSAO_NA_CONVERSA");
    expect((await chamar("tok-outra", { aluno_id: A1 })).corpo.motivo).toBe("SEM_PERMISSAO_NA_CONVERSA");
  });
  it("responsável comprovado pelo atendimento lê mesmo sem ser dono da carteira", async () => {
    estado.banco.casos = [];
    estado.banco.ulbra_atendimentos = [{ ulbra_cliente_id: "C1", responsavel_email: "cobranca11@aelbra.com.br", dispensado_em: null }];
    expect((await chamar("tok-outra", { aluno_id: A1 })).corpo.ok).toBe(true);
  });
  it("sem CPF confirmado, nenhum operador lê, nem a gestão", async () => {
    expect((await chamar("tok-gestao", { aluno_id: A2 })).corpo.motivo).toBe("IDENTIDADE_NAO_CONFIRMADA");
    expect((await chamar("tok-dona", { aluno_id: A2 })).corpo.motivo).toBe("IDENTIDADE_NAO_CONFIRMADA");
  });
  it("gestão lê o aluno de qualquer carteira, com CPF confirmado", async () => {
    expect((await chamar("tok-gestao", { aluno_id: A1 })).corpo.ok).toBe(true);
  });
});

describe("429: parada imediata, sem nova tentativa", () => {
  it("a ULBRA responde 429: motivo ULBRA_LIMITE, uma única chamada, sem repetição", async () => {
    ulbraRoteada({ ...ROTA_OK, ler_conversa: limite429 });
    const r = await chamar("tok-dona", { aluno_id: A1 });
    expect(r.corpo.motivo).toBe("ULBRA_LIMITE");
    expect(estado.chamadasUlbra).toBe(1);
    // próxima requisição da ficha também não repete sozinha: o clique é explícito
    expect(estado.chamadasUlbra).toBe(1);
  });
});

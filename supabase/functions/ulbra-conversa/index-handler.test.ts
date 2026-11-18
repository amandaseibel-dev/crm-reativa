// EXECUÇÃO do handler real (index.ts) com transporte e banco falsos. Sem rede.
// Carregamento: shim de Deno (env + serve capturado), cliente do Supabase substituído pelo mock de
// "https://esm.sh/@supabase/supabase-js@2" e fetch global substituído. Casos: sem JWT; usuário inativo;
// flag desligada ou fora da lista do piloto; lista correta sem conexão individual; conexão sem
// responsabilidade pelo atendimento; falha de auditoria (o texto não pode sair).
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { chaveDeHex, cifrar } from "./cripto.ts";

const CHAVE_HEX = "00".repeat(32);
const EU = "cobranca10@aelbra.com.br";
const OUTRO = "cobranca07@aelbra.com.br";
const CONV = "a".repeat(24);
const CPF_FALHA = "11111111111"; // caso cuja verificação de encerramento falha (só no teste (i))

const estado: {
  env: Record<string, string>;
  user: { email: string } | null;
  usuario: { ativo: boolean; perfil: string } | null;
  conexao: Record<string, unknown> | null;
  responsavel: string;
  dono: string | null;
  encerrado: boolean;
  donoExtra: string | null;
  rpcErro: boolean;
  rpcNulo: boolean;
  rpcNuloCpf: string | null;
  auditoriaFalha: boolean;
  auditorias: Record<string, unknown>[];
} = { env: {}, user: null, usuario: null, conexao: null, responsavel: EU, dono: EU, encerrado: false, donoExtra: null, rpcErro: false, rpcNulo: false, rpcNuloCpf: null, auditoriaFalha: false, auditorias: [] };

// Dados por tabela: maybeSingle devolve um registro; "then" (sem maybeSingle) devolve lista.
const UNICO: Record<string, () => unknown> = {
  usuarios: () => estado.usuario,
  ulbra_conversas: () => ({ ulbra_cliente_id: "cli-1" }),
  ulbra_vinculos: () => ({ aluno_id: "al-1" }),
  ulbra_conexoes_operador: () => estado.conexao,
};
const LISTA: Record<string, () => unknown[]> = {
  casos: () =>
    [estado.dono, estado.donoExtra]
      .filter((op): op is string => Boolean(op))
      .map((op) => ({ operador_email: op, cpf_limpo: op === OUTRO ? CPF_FALHA : "00000000000", status_atual: "ATIVO", status_acionamento: "EM ANDAMENTO", status_financeiro: "EM ABERTO", status_jornada: "ATIVO" })),
  ulbra_atendimentos: () => [{ responsavel_email: estado.responsavel }],
};

function builder(tabela: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "ilike", "eq", "is", "not", "limit", "order", "in", "update", "upsert", "delete"]) {
    b[m] = () => b;
  }
  // Auditoria: o insert é aguardado; com falha simulada devolve erro (o handler então não entrega o texto).
  b.insert = (linha: Record<string, unknown>) => {
    if (tabela === "auditoria" && !estado.auditoriaFalha) estado.auditorias.push(linha);
    return {
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: estado.auditoriaFalha && tabela === "auditoria" ? { message: "falha simulada" } : null }).then(res),
    };
  };
  b.maybeSingle = async () => ({ data: UNICO[tabela]?.() ?? null, error: null });
  b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: LISTA[tabela]?.() ?? UNICO[tabela]?.() ?? null, error: null }).then(res);
  return b;
}

const fakeClient = () => ({
  auth: { getUser: async () => ({ data: { user: estado.user } }) },
  from: (tabela: string) => builder(tabela),
  rpc: async (fn: string, args?: { p_cpf?: string }) => {
    const falha = fn === "caso_encerrado_operacional" && args?.p_cpf === CPF_FALHA;
    if (falha && estado.rpcErro) return { data: null, error: { message: "falha simulada na verificação" } };
    if (fn === "caso_encerrado_operacional" && estado.rpcNulo) return { data: null, error: null }; // retorno nulo, sem erro, em qualquer caso
    if (fn === "caso_encerrado_operacional" && estado.rpcNuloCpf && args?.p_cpf === estado.rpcNuloCpf) return { data: null, error: null };
    return { data: fn === "caso_encerrado_operacional" ? estado.encerrado : "GRAVADA", error: null };
  },
});

vi.mock("https://esm.sh/@supabase/supabase-js@2", () => ({ createClient: () => fakeClient() }));

let handler: (req: Request) => Promise<Response>;
const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));

beforeAll(async () => {
  (globalThis as unknown as { Deno: unknown }).Deno = {
    env: { get: (k: string) => estado.env[k] },
    serve: (fn: (req: Request) => Promise<Response>) => { handler = fn; },
  };
  vi.stubGlobal("fetch", fetchMock);
  await import("./index.ts");
});

beforeEach(() => {
  fetchMock.mockClear();
  estado.env = {
    SUPABASE_URL: "https://banco.test",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "servico",
    ULBRA_TOKENS_CHAVE: CHAVE_HEX,
    ULBRA_HISTORICO_HABILITADO: "true",
    ULBRA_HISTORICO_PILOTO_EMAILS: EU,
  };
  estado.user = { email: EU };
  estado.usuario = { ativo: true, perfil: "operador" };
  estado.conexao = null;
  estado.responsavel = EU;
  estado.dono = EU;
  estado.encerrado = false;
  estado.donoExtra = null;
  estado.rpcErro = false;
  estado.rpcNulo = false;
  estado.rpcNuloCpf = null;
  estado.auditoriaFalha = false;
  estado.auditorias = [];
});

function req(corpo: unknown, auth = "Bearer token-do-usuario"): Request {
  return new Request("https://ulbra.test/functions/v1/ulbra-conversa", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(corpo),
  });
}

async function chamar(corpo: unknown, auth?: string) {
  const r = await handler(req(corpo, auth));
  return { status: r.status, corpo: (await r.json()) as Record<string, unknown> };
}

async function conexaoIndividual(token: string) {
  const chave = chaveDeHex(CHAVE_HEX);
  return {
    access_token_cifrado: await cifrar(token, chave),
    refresh_token_cifrado: null,
    expira_em: new Date(Date.now() + 3600_000).toISOString(),
    revogada_em: null,
    pessoa_email: EU,
    pessoa_nome: "João",
  };
}

const LEITURA_OK = () =>
  new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify({ mensagens: [{ quem: "cliente", em: "2026-11-16T10:00:00Z", texto: "TEXTO-SECRETO" }], paginacao: {} }) }] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("handler real (index.ts): caminhos negados do histórico", () => {
  it("(a) sem JWT: recusado antes de tudo, sem chamada à Mensageria", async () => {
    const r = await chamar({ acao: "historico_ler", conversa_id: CONV }, "");
    expect(r.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(a2) JWT sem e-mail: 403, sem chamada à Mensageria", async () => {
    estado.user = { email: "" };
    const r = await chamar({ acao: "historico_ler", conversa_id: CONV });
    expect(r.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(b) usuário inativo: 403, sem chamada à Mensageria", async () => {
    estado.usuario = null; // o handler só aceita usuário ativo (.eq('ativo', true))
    const r = await chamar({ acao: "historico_ler", conversa_id: CONV });
    expect(r.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(c1) flag desligada: HISTORICO_DESLIGADO, sem chamada à Mensageria e sem auditoria de leitura", async () => {
    estado.env.ULBRA_HISTORICO_HABILITADO = "false";
    const r = await chamar({ acao: "historico_ler", conversa_id: CONV });
    expect(r.corpo.motivo).toBe("HISTORICO_DESLIGADO");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(estado.auditorias.filter((a) => a.acao === "ULBRA_HISTORICO_LEITURA")).toHaveLength(0);
  });

  it("(c1b) flag desligada: a CAPACIDADE também é negada pelo servidor (a UI não libera nada)", async () => {
    estado.env.ULBRA_HISTORICO_HABILITADO = "false";
    const r = await chamar({ acao: "historico_capacidade", conversa_id: CONV });
    expect(r.corpo.pode).toBe(false);
    expect(r.corpo.motivo).toBe("HISTORICO_DESLIGADO");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(c2) e-mail fora de ULBRA_HISTORICO_PILOTO_EMAILS: HISTORICO_DESLIGADO, sem chamada à Mensageria", async () => {
    estado.user = { email: OUTRO };
    estado.usuario = { ativo: true, perfil: "operador" };
    const r = await chamar({ acao: "historico_ler", conversa_id: CONV });
    expect(r.corpo.motivo).toBe("HISTORICO_DESLIGADO");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(d) lista correta, sem conexão individual ativa: SEM_CONEXAO, sem chamada à Mensageria e sem fallback central", async () => {
    const r = await chamar({ acao: "historico_ler", conversa_id: CONV });
    expect(r.status).toBe(403);
    expect(r.corpo.motivo).toBe("SEM_CONEXAO");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(d2) sanidade: com conexão individual, a mesma entrada chega à leitura (usa o token do operador)", async () => {
    estado.conexao = await conexaoIndividual("token-individual-do-operador");
    fetchMock.mockResolvedValueOnce(LEITURA_OK());
    await chamar({ acao: "historico_ler", conversa_id: CONV });
    expect(fetchMock).toHaveBeenCalled();
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token-individual-do-operador");
  });

  it("(e) com conexão, mas NÃO dono da carteira nem responsável pelo atendimento: nega antes da leitura, sem chamada à Mensageria", async () => {
    estado.responsavel = OUTRO;
    estado.dono = OUTRO;
    estado.conexao = await conexaoIndividual("token-individual-do-operador");
    const r = await chamar({ acao: "historico_ler", conversa_id: CONV });
    expect(r.status).toBe(403);
    expect(r.corpo.motivo).toBe("SEM_PERMISSAO_NA_CONVERSA");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(f) falha de auditoria: 500 AUDITORIA_NAO_GRAVADA e o texto NÃO sai, mesmo com a leitura permitida", async () => {
    estado.conexao = await conexaoIndividual("token-individual-do-operador");
    estado.auditoriaFalha = true;
    fetchMock.mockResolvedValueOnce(LEITURA_OK());
    const r = await chamar({ acao: "historico_ler", conversa_id: CONV });
    expect(r.status).toBe(500);
    expect(r.corpo.motivo).toBe("AUDITORIA_NAO_GRAVADA");
    expect(JSON.stringify(r.corpo)).not.toContain("TEXTO-SECRETO");
  });

  it("(g) caso ENCERRADO de antigo dono, sem responsabilidade atual: SEM_PERMISSAO_NA_CONVERSA, sem chamada e sem auditoria", async () => {
    estado.responsavel = OUTRO;
    estado.dono = EU;
    estado.encerrado = true; // caso encerrado (caso_encerrado_operacional) não autoriza leitura
    estado.conexao = await conexaoIndividual("token-individual-do-operador");
    const r = await chamar({ acao: "historico_ler", conversa_id: CONV });
    expect(r.corpo.motivo).toBe("SEM_PERMISSAO_NA_CONVERSA");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(estado.auditorias).toHaveLength(0);
  });
});

describe("handler real (index.ts): erro na verificação de caso não autoriza", () => {
  it("(i) dois casos do aluno (EU e OUTRO) e a verificação falha em um: NINGUÉM é dono; sem leitura, sem auditoria", async () => {
    estado.donoExtra = OUTRO;
    estado.rpcErro = true;
    estado.responsavel = OUTRO;
    estado.conexao = await conexaoIndividual("token-individual-do-operador");
    const r = await chamar({ acao: "historico_ler", conversa_id: CONV });
    expect(r.corpo.motivo).toBe("SEM_PERMISSAO_NA_CONVERSA");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(estado.auditorias).toHaveLength(0);
  });
});

describe("handler real (index.ts): retorno não booleano também nega", () => {
  it("(j) ÚNICO caso do dono devolve nulo sem erro: não é dono (não se ignora o caso e se mantém o outro); sem leitura, sem auditoria", async () => {
    estado.donoExtra = null; // só o próprio operador, com um único caso
    estado.rpcNulo = true;
    estado.responsavel = OUTRO;
    estado.conexao = await conexaoIndividual("token-individual-do-operador");
    const r = await chamar({ acao: "historico_ler", conversa_id: CONV });
    expect(r.corpo.motivo).toBe("SEM_PERMISSAO_NA_CONVERSA");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(estado.auditorias).toHaveLength(0);
  });
});

describe("handler real (index.ts): nulo em um caso e dono ATIVO no outro", () => {
  it("(k) caso de OUTRO devolve nulo (sem erro) e o do próprio operador é ativo: NINGUÉM é dono; sem leitura, sem auditoria", async () => {
    estado.donoExtra = OUTRO; // dois casos do mesmo aluno: EU (false) e OUTRO (nulo)
    estado.rpcNuloCpf = CPF_FALHA;
    estado.responsavel = OUTRO;
    estado.conexao = await conexaoIndividual("token-individual-do-operador");
    const r = await chamar({ acao: "historico_ler", conversa_id: CONV });
    expect(r.corpo.motivo).toBe("SEM_PERMISSAO_NA_CONVERSA");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(estado.auditorias).toHaveLength(0);
  });
});

describe("handler real (index.ts): caminho positivo completo", () => {
  it("(h) dono ativo + conexão individual: texto sai SOMENTE depois da auditoria ULBRA_HISTORICO_LEITURA gravada", async () => {
    estado.conexao = await conexaoIndividual("token-individual-do-operador");
    fetchMock.mockResolvedValueOnce(LEITURA_OK());
    const r = await chamar({ acao: "historico_ler", conversa_id: CONV });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.corpo)).toContain("TEXTO-SECRETO");
    const leituras = estado.auditorias.filter((a) => a.acao === "ULBRA_HISTORICO_LEITURA");
    expect(leituras).toHaveLength(1);
    expect(JSON.stringify(leituras[0])).not.toContain("TEXTO-SECRETO");
  });
});

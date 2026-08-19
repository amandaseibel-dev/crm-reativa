import { describe, it, expect, vi, beforeEach } from "vitest";

// A camada de serviço fala com o Supabase; aqui só interessa QUANDO ela fala.
const espiao = vi.hoisted(() => ({ rpcs: [], resposta: { data: [], error: null } }));
vi.mock("./supabase", () => ({
  supabase: {
    rpc: vi.fn(async (nome, args) => {
      espiao.rpcs.push({ nome, args });
      return espiao.resposta;
    }),
  },
}));

import { esperaDesde, linkWhatsApp, procurarConversaPorTelefone } from "./whatsapp";

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const atras = (ms) => new Date(Date.now() - ms).toISOString();
const daqui = (ms) => new Date(Date.now() + ms).toISOString();

describe("esperaDesde — quanto tempo a pessoa está sem resposta", () => {
  it("conta em minutos na primeira hora", () => {
    expect(esperaDesde(atras(20 * MIN)).texto).toBe("20min");
  });

  it("conta em horas depois de 1h", () => {
    expect(esperaDesde(atras(3 * HORA)).texto).toBe("3h");
  });

  it("conta em dias depois de 24h", () => {
    expect(esperaDesde(atras(2 * DIA)).texto).toBe("2d");
  });

  it("escala a urgencia: calmo -> atencao -> critico", () => {
    expect(esperaDesde(atras(10 * MIN)).nivel).toBe("calmo");
    expect(esperaDesde(atras(2 * HORA)).nivel).toBe("atencao");
    expect(esperaDesde(atras(30 * HORA)).nivel).toBe("critico");
  });

  it("1h e 24h sao os limites exatos", () => {
    expect(esperaDesde(atras(HORA + 1000)).nivel).toBe("atencao");
    expect(esperaDesde(atras(DIA + 1000)).nivel).toBe("critico");
  });

  it("sem data nao inventa espera", () => {
    expect(esperaDesde(null)).toBeNull();
    expect(esperaDesde(undefined)).toBeNull();
  });

  it("data no futuro nao vira espera negativa", () => {
    expect(esperaDesde(daqui(HORA))).toBeNull();
  });
});

// A JANELA DE 24H NAO EXISTE MAIS. Ela era regra de tarifacao da Cloud API da
// Meta: fora dela so passava modelo aprovado, que e cobrado. No caminho por QR
// Code nao ha template, nao ha custo por conversa e nao ha prazo para
// responder. Os testes de `tempoRestanteJanela` sairam junto com a funcao.
//
// O que passou a travar o campo de resposta e outra coisa, e e testado na tela:
// o NUMERO estar fora do ar, ou a conversa estar finalizada.

describe("linkWhatsApp", () => {
  it("monta o link no numero certo", () => {
    expect(linkWhatsApp("5551999998888")).toBe("https://wa.me/5551999998888");
  });

  it("limpa mascara", () => {
    expect(linkWhatsApp("+55 (51) 99999-8888")).toBe("https://wa.me/5551999998888");
  });

  it("sem telefone nao gera link quebrado", () => {
    expect(linkWhatsApp("")).toBeNull();
    expect(linkWhatsApp(null)).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// A consulta "já existe conversa com este número?" roda enquanto o operador
// DIGITA. Com 11 operadores na Central, disparar uma consulta por tecla — e
// ainda por cima com número pela metade — é o tipo de detalhe que derruba o
// banco. O guarda-corpo é o próprio serviço.
// ---------------------------------------------------------------------------
describe("procurarConversaPorTelefone — não bate no banco à toa", () => {
  beforeEach(() => {
    espiao.rpcs = [];
    espiao.resposta = { data: [], error: null };
  });

  it("não consulta enquanto o número está incompleto", async () => {
    expect(await procurarConversaPorTelefone("c1", "519999")).toBeNull();
    expect(espiao.rpcs.length).toBe(0);
  });

  it("não consulta sem canal escolhido", async () => {
    expect(await procurarConversaPorTelefone(null, "51999998888")).toBeNull();
    expect(espiao.rpcs.length).toBe(0);
  });

  it("não consulta com o campo vazio", async () => {
    expect(await procurarConversaPorTelefone("c1", "")).toBeNull();
    expect(espiao.rpcs.length).toBe(0);
  });

  it("consulta quando o número fica válido", async () => {
    espiao.resposta = { data: [{ conversa_id: "k1", responsavel_nome: "Maria" }], error: null };
    const r = await procurarConversaPorTelefone("c1", "(51) 99999-8888");
    expect(r.conversa_id).toBe("k1");
    expect(espiao.rpcs).toEqual([
      { nome: "whatsapp_conversa_por_telefone", args: { p_canal_id: "c1", p_telefone: "(51) 99999-8888" } },
    ]);
  });

  it("número sem conversa devolve nulo, não lista vazia", async () => {
    espiao.resposta = { data: [], error: null };
    expect(await procurarConversaPorTelefone("c1", "51999998888")).toBeNull();
  });

  it("erro do banco sobe — a tela não pode achar que o número está livre", async () => {
    espiao.resposta = { data: null, error: { message: "acesso negado" } };
    await expect(procurarConversaPorTelefone("c1", "51999998888")).rejects.toThrow("acesso negado");
  });
});

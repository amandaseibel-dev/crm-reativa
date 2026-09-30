// Fluxo COMPLETO da Edge `prime-academico`, com dependências simuladas.
//
// POR QUE ESTE ARQUIVO EXISTE
// ---------------------------------------------------------------------------
// `academico.test.js` cobre as funções puras, e passava inteiro enquanto a
// função estava QUEBRADA: `index.ts` gravava `p_total_items: totalItems` com
// um identificador que nunca foi declarado. Em Deno isso é ReferenceError na
// primeira consulta -- toda consulta, da ficha e do piloto. Nenhum teste de
// unidade pega isso, porque o defeito não está em nenhuma unidade: está na
// costura.
//
// Então aqui o módulo é IMPORTADO E EXECUTADO. `Deno` e o `fetch` são dublês,
// e o import remoto do supabase-js é redirecionado por `vitest.config.js`.
//
// O QUE SE ASSERE, principalmente: o objeto REALMENTE ENVIADO à RPC de
// gravação. É ele que vira registro, e é dele que a ficha lê depois.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { programarCliente } from "./_duble-supabase-js.js";

const ALUNO = "aaaaaaaa-1111-4222-8333-444444444444";
const ITEM = "bbbbbbbb-1111-4222-8333-444444444444";
const EXEC = "cccccccc-1111-4222-8333-444444444444";
const CPF_BRUTO = "11111111111";       // ficticio
const CPF_FMT = "111.111.111-11";
const CPF_OUTRO = "222.222.222-22";    // ficticio

const AMBIENTE = {
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_SERVICE_ROLE_KEY: "service-inerte",
  SUPABASE_ANON_KEY: "anon-inerte",
  PRIME_API_KEY: "chave-inerte-de-teste",
  ROTINA_TOKEN: "",
};

let handler;      // o que `Deno.serve` recebeu
let rpcs;         // toda chamada de RPC, em ordem
let respostas;    // nome da RPC -> resposta
let buscas;       // toda chamada ao Prime
let paginas;      // fila de respostas do Prime

beforeAll(async () => {
  globalThis.Deno = {
    serve: (fn) => { handler = fn; },
    env: { get: (k) => AMBIENTE[k] ?? "" },
  };
  globalThis.fetch = async (url) => {
    buscas.push(String(url));
    const p = paginas.shift();
    if (!p) throw new Error("o teste nao previu mais uma pagina: " + url);
    if (p.rede) { const e = new Error("rede"); e.name = "TypeError"; throw e; }
    return { status: p.http ?? 200, ok: (p.http ?? 200) < 400,
             text: async () => p.texto ?? JSON.stringify(p.corpo) };
  };
  await import("./index.ts");
  expect(handler, "index.ts nao registrou handler em Deno.serve").toBeTypeOf("function");
});

beforeEach(() => {
  rpcs = []; buscas = []; paginas = [];
  respostas = {
    usuario_e_gestao: { data: true },
    prime_academico_registrar: { data: "consulta-1" },
    prime_academico_ultima: { data: { ultima: null, ultima_boa: null } },
    prime_academico_piloto_validar: { data: { ok: true, orcamento: 10 } },
    prime_academico_piloto_autorizar_pagina: { data: { ok: true } },
    prime_academico_piloto_registrar: { data: { parar: false } },
  };
  programarCliente((_url, chave) => {
    const rpc = async (nome, args) => {
      rpcs.push({ nome, args });
      return { error: null, ...(respostas[nome] ?? { data: null }) };
    };
    if (chave === AMBIENTE.SUPABASE_SERVICE_ROLE_KEY) {
      return {
        rpc,
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: ALUNO, cpf: CPF_BRUTO }, error: null }),
            }),
          }),
        }),
      };
    }
    return { rpc, auth: { getUser: async () => ({ data: { user: { email: "gestao@exemplo.invalido" } } }) } };
  });
});

const pedir = (corpo) => handler(new Request("http://edge/prime-academico", {
  method: "POST",
  headers: { Authorization: "Bearer sessao-de-gestao", "Content-Type": "application/json" },
  body: JSON.stringify(corpo),
}));

const linha = (cpf, o = {}) => ({ cpf, registration: "990100001", course: "CURSO A", status: "ATIVO", ...o });
const gravacao = () => rpcs.find((c) => c.nome === "prime_academico_registrar")?.args;

describe("consulta pela FICHA (sem piloto)", () => {
  it("grava COM_VINCULOS e o totalItems que a API declarou", async () => {
    paginas = [{ corpo: { items: [linha(CPF_FMT), linha(CPF_OUTRO)], totalItems: 2 } }];
    const r = await pedir({ aluno_id: ALUNO });
    expect(r.status).toBe(200);

    const g = gravacao();
    expect(g).toBeTruthy();
    // O DEFEITO ORIGINAL: `totalItems` nao existia e a funcao nem chegava aqui.
    expect(g.p_total_items).toBe(2);
    expect(g.p_resultado).toBe("COM_VINCULOS");
    expect(g.p_detalhe_falha).toBeNull();
    expect(g.p_requisicoes).toBe(1);
    // filtrado por CPF: a linha do terceiro nao entra
    expect(g.p_vinculos).toHaveLength(1);
    expect(g.p_vinculos[0].registration).toBe("990100001");
    // ficha nao mexe no piloto
    expect(rpcs.some((c) => c.nome.startsWith("prime_academico_piloto"))).toBe(false);
  });

  it("busca terminada e sem linha DESTA pessoa e SEM_RESULTADO", async () => {
    paginas = [{ corpo: { items: [linha(CPF_OUTRO)], totalItems: 1 } }];
    await pedir({ aluno_id: ALUNO });
    expect(gravacao().p_resultado).toBe("SEM_RESULTADO");
    expect(gravacao().p_vinculos).toHaveLength(0);
  });
});

describe("consulta pelo PILOTO", () => {
  it("autoriza cada pagina antes de buscar e fecha o item", async () => {
    paginas = [{ corpo: { items: [linha(CPF_FMT)], totalItems: 1 } }];
    const r = await pedir({ aluno_id: ALUNO, piloto_item_id: ITEM, piloto_execucao: EXEC });
    expect(r.status).toBe(200);

    const ordem = rpcs.map((c) => c.nome);
    expect(ordem.indexOf("prime_academico_piloto_autorizar_pagina"))
      .toBeLessThan(ordem.indexOf("prime_academico_registrar"));

    const aut = rpcs.find((c) => c.nome === "prime_academico_piloto_autorizar_pagina");
    expect(aut.args).toMatchObject({ p_item: ITEM, p_aluno_id: ALUNO, p_execucao: EXEC });
    const fecha = rpcs.find((c) => c.nome === "prime_academico_piloto_registrar");
    expect(fecha.args).toMatchObject({ p_consulta_id: "consulta-1", p_requisicoes: 1, p_execucao: EXEC });
    expect(gravacao().p_total_items).toBe(1);
  });
});

describe("autorizacao NEGADA na primeira pagina", () => {
  beforeEach(() => { respostas.prime_academico_piloto_autorizar_pagina = { data: { ok: false, motivo: "orcamento esgotado" } }; });

  it("nao chama o Prime e NAO grava SEM_RESULTADO", async () => {
    paginas = [];
    const r = await pedir({ aluno_id: ALUNO, piloto_item_id: ITEM, piloto_execucao: EXEC });
    expect(r.status).toBe(200);
    expect(buscas).toHaveLength(0);          // a Ulbra nao foi consultada

    const g = gravacao();
    // O SEGUNDO DEFEITO: isto era SEM_RESULTADO -- "consultei e o aluno nao tem
    // vinculo" sobre uma consulta que nunca saiu. E, sendo desfecho completo,
    // virava `ultima_boa` e apagava a ultima consulta boa de verdade.
    expect(g.p_resultado).toBe("PAGINACAO_INCOMPLETA");
    expect(g.p_requisicoes).toBe(0);
    expect(g.p_total_items).toBeNull();
    expect(g.p_detalhe_falha).toContain("orcamento esgotado");
    expect(g.p_detalhe_falha).toContain("nenhuma requisicao foi enviada");
  });

  it("o desfecho incompleto nao entra no criterio de `ultima_boa`", async () => {
    paginas = [];
    await pedir({ aluno_id: ALUNO, piloto_item_id: ITEM, piloto_execucao: EXEC });
    // `prime_academico_ultima` so promove COM_VINCULOS e SEM_RESULTADO
    expect(["COM_VINCULOS", "SEM_RESULTADO"]).not.toContain(gravacao().p_resultado);
  });
});

describe("interrupcao DEPOIS de pagina sem correspondencia de CPF", () => {
  it("pagina cheia so de terceiros + negativa = INCOMPLETA, nunca SEM_RESULTADO", async () => {
    // 50 linhas de OUTRAS pessoas: pagina cheia, logo ha mais a buscar.
    paginas = [{ corpo: { items: Array.from({ length: 50 }, () => linha(CPF_OUTRO)) } }];
    let n = 0;
    respostas.prime_academico_piloto_autorizar_pagina = { data: { ok: true } };
    programarCliente((_url, chave) => {
      const rpc = async (nome, args) => {
        rpcs.push({ nome, args });
        if (nome === "prime_academico_piloto_autorizar_pagina") {
          n += 1;
          return n === 1 ? { data: { ok: true }, error: null }
                         : { data: { ok: false, motivo: "teto do lote" }, error: null };
        }
        return { error: null, ...(respostas[nome] ?? { data: null }) };
      };
      if (chave === AMBIENTE.SUPABASE_SERVICE_ROLE_KEY) {
        return { rpc, from: () => ({ select: () => ({ eq: () => ({
          maybeSingle: async () => ({ data: { id: ALUNO, cpf: CPF_BRUTO }, error: null }) }) }) }) };
      }
      return { rpc, auth: { getUser: async () => ({ data: { user: { email: "g@exemplo.invalido" } } }) } };
    });

    await pedir({ aluno_id: ALUNO, piloto_item_id: ITEM, piloto_execucao: EXEC });
    const g = gravacao();
    expect(buscas).toHaveLength(1);
    expect(g.p_requisicoes).toBe(1);
    expect(g.p_vinculos).toHaveLength(0);     // nenhuma linha era dela...
    expect(g.p_resultado).toBe("PAGINACAO_INCOMPLETA"); // ...mas a busca nao acabou
    expect(g.p_detalhe_falha).toContain("teto do lote");
    expect(g.p_detalhe_falha).toContain("a lista pode estar incompleta");
  });
});

describe("falha de comunicacao continua distinta", () => {
  it("HTTP 500 e FALHA_COMUNICACAO, nao SEM_RESULTADO", async () => {
    paginas = [{ http: 500, texto: "erro" }];
    await pedir({ aluno_id: ALUNO });
    const g = gravacao();
    expect(g.p_resultado).toBe("FALHA_COMUNICACAO");
    expect(g.p_http_status).toBe(500);
    expect(g.p_vinculos).toHaveLength(0);
  });
});

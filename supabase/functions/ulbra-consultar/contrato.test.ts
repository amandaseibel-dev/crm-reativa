// Teste de contrato do MCP da Mensageria Ulbra: fixtures na FORMA real medida
// em 2026-11-04 (ids e nomes trocados). Se a Mensageria mudar a forma, este
// é o teste que deve quebrar — nunca o mock da tela.
import { describe, it, expect } from "vitest";
import {
  contatosDeChaves,
  extrairResultado,
  interpretar,
  interpretarPorChave,
  montarChamada,
  montarChamadaMulti,
  montarChaves,
} from "./mcp.ts";

function envelope(texto: unknown) {
  return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(texto) }] } };
}

const CLIENTE_A = "6a8353957e2e9cae71e8207f";
const CLIENTE_B = "6a8353957e2e9cae71e82080";

const NO_ESCOPO_EM_ATENDIMENTO = {
  resultados: [
    { posicao: 0, existe: true, cliente: { id: CLIENTE_A }, equipe: "Reativa", emAtendimento: { equipe: "Reativa" } },
  ],
  chamada: "6aeb12c5b0d037965ad8cf55",
};

const EXISTE_SEM_ESCOPO_NEM_EQUIPE = {
  resultados: [{ posicao: 0, existe: true, equipe: null, emAtendimento: null }],
  chamada: "6aeb12c5b0d037965ad8cf56",
};

const FORA_DO_ESCOPO = {
  resultados: [{ posicao: 0, existe: true, equipe: "Financeiro", emAtendimento: null }],
};

const NAO_EXISTE = { resultados: [{ posicao: 0, existe: false }] };

describe("ulbra-consultar contrato: pedido", () => {
  it("conferir_duplicidade recebe contatos[] e não telefone solto", () => {
    const c = montarChamada({ telefone: "5551999990000" });
    expect(c.method).toBe("tools/call");
    expect(c.params.name).toBe("conferir_duplicidade");
    expect(c.params.arguments).toEqual({ contatos: [{ telefone: "5551999990000" }] });
    expect(c.params.arguments).not.toHaveProperty("telefone");
  });

  it("telefone e CPF vão na MESMA chamada, em duas posições", () => {
    const m = montarChaves({ telefone: "(51) 99999-0000", cpf: "123.456.789-01" });
    if ("erro" in m) throw new Error("devia montar as duas chaves");
    const c = montarChamadaMulti(contatosDeChaves(m.chaves, m.ordem));
    expect(c.params.arguments).toEqual({
      contatos: [{ telefone: "51999990000" }, { cpf: "12345678901" }],
    });
  });

  it("recusa chamada vazia e acima das 20 posições do limite medido", () => {
    expect(() => montarChamadaMulti([])).toThrow(/CONTATOS_FORA_DO_LIMITE/);
    const vinteUm = Array.from({ length: 21 }, () => ({ cpf: "12345678901" }));
    expect(() => montarChamadaMulti(vinteUm)).toThrow(/CONTATOS_FORA_DO_LIMITE/);
  });
});

describe("ulbra-consultar contrato: envelope JSON-RPC", () => {
  it("extrai o JSON de result.content[0].text", () => {
    expect(extrairResultado(envelope(NAO_EXISTE))).toEqual(NAO_EXISTE);
  });

  it("falha fechado com error no envelope", () => {
    expect(() => extrairResultado({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "limite" } })).toThrow(/MCP_ERRO/);
  });

  it("falha fechado sem conteúdo", () => {
    expect(() => extrairResultado({ result: {} })).toThrow(/ENVELOPE_SEM_CONTEUDO/);
    expect(() => extrairResultado(null)).toThrow(/ENVELOPE_INVALIDO/);
  });
});

describe("ulbra-consultar contrato: interpretação de resultados[]", () => {
  it("cliente no escopo → vinculado com equipe e atendimento", () => {
    expect(interpretar(NO_ESCOPO_EM_ATENDIMENTO)).toEqual({
      status: "vinculado",
      ulbra_cliente_id: CLIENTE_A,
      equipe: "Reativa",
      em_atendimento: true,
    });
  });

  it("existe:true sem cliente nem equipe (telefone inexistente) → NAO_ENCONTRADO", () => {
    expect(interpretar(EXISTE_SEM_ESCOPO_NEM_EQUIPE)).toEqual({ status: "nao_encontrado", motivo: "NAO_ENCONTRADO" });
  });

  it("existe em outra equipe, sem cliente.id → FORA_DO_ESCOPO", () => {
    expect(interpretar(FORA_DO_ESCOPO)).toEqual({ status: "nao_encontrado", motivo: "FORA_DO_ESCOPO" });
  });

  it("existe:false → NAO_ENCONTRADO", () => {
    expect(interpretar(NAO_EXISTE)).toEqual({ status: "nao_encontrado", motivo: "NAO_ENCONTRADO" });
  });

  it("forma antiga (clientes[]) não é mais aceita: vira RESPOSTA_INVALIDA", () => {
    expect(interpretar({ clientes: [{ id: "x", equipe: "Reativa" }] })).toEqual({ status: "erro", motivo: "RESPOSTA_INVALIDA" });
    expect(interpretar(null)).toEqual({ status: "erro", motivo: "RESPOSTA_INVALIDA" });
  });

  it("nunca devolve telefone ou CPF", () => {
    const r = interpretar(NO_ESCOPO_EM_ATENDIMENTO) as Record<string, unknown>;
    expect(r).not.toHaveProperty("telefone");
    expect(r).not.toHaveProperty("cpf");
  });
});

// ---------------------------------------------------------------------------
// O casamento por POSIÇÃO é o ponto onde um erro silencioso trocaria o
// resultado do telefone pelo do CPF — e gravaria vínculo no aluno errado sem
// nenhuma exceção aparecer. Por isso cada forma torta tem teste próprio.
// ---------------------------------------------------------------------------
describe("ulbra-consultar contrato: casamento por posição", () => {
  const ordem = ["telefone", "cpf"] as const;

  it("casa cada posição com a sua chave", () => {
    const r = interpretarPorChave({
      resultados: [
        { posicao: 0, existe: true, cliente: { id: CLIENTE_A }, equipe: "Reativa", emAtendimento: null },
        { posicao: 1, existe: true, cliente: { id: CLIENTE_B }, equipe: "Reativa", emAtendimento: null },
      ],
    }, [...ordem]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.porChave.telefone).toMatchObject({ ulbra_cliente_id: CLIENTE_A });
    expect(r.porChave.cpf).toMatchObject({ ulbra_cliente_id: CLIENTE_B });
  });

  it("usa `posicao`, NUNCA a ordem de chegada do array", () => {
    // Mesmas duas posições, chegando ao contrário: o CPF (posição 1) continua
    // sendo o CLIENTE_B, não o primeiro item do array.
    const r = interpretarPorChave({
      resultados: [
        { posicao: 1, existe: true, cliente: { id: CLIENTE_B }, equipe: "Reativa", emAtendimento: null },
        { posicao: 0, existe: true, cliente: { id: CLIENTE_A }, equipe: "Reativa", emAtendimento: null },
      ],
    }, [...ordem]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.porChave.telefone).toMatchObject({ ulbra_cliente_id: CLIENTE_A });
    expect(r.porChave.cpf).toMatchObject({ ulbra_cliente_id: CLIENTE_B });
  });

  // A numeração de `posicao` em chamada de DUAS chaves nunca foi medida: o
  // contrato de 04/11/2026 só tem resposta de uma posição. Se a Mensageria
  // numerar a partir de 1, a leitura tem de continuar funcionando — senão
  // todo vínculo para de ser criado, por um detalhe que ninguém mediu.
  // Base 1 é convenção NÃO confirmada, então só é aceita quando o mapeamento
  // não pode mudar a decisão: mesmo cliente em todas as posições, ou nenhuma
  // com cliente. Assimetria falha fechado — ver os dois testes seguintes.
  it("aceita numeração a partir de 1 quando o mapeamento é indiferente", () => {
    const r = interpretarPorChave({
      resultados: [
        { posicao: 1, existe: true, cliente: { id: CLIENTE_A }, equipe: "Reativa", emAtendimento: null },
        { posicao: 2, existe: true, cliente: { id: CLIENTE_A }, equipe: "Reativa", emAtendimento: null },
      ],
    }, ["telefone", "cpf"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.porChave.telefone).toMatchObject({ ulbra_cliente_id: CLIENTE_A });
    expect(r.porChave.cpf).toMatchObject({ ulbra_cliente_id: CLIENTE_A });
  });

  it("base 1 com clientes diferentes falha fechado (numeração não medida)", () => {
    // Se as posições estiverem trocadas, telefone e CPF trocam de resultado.
    // Com clientes diferentes isso decide coisas opostas: recusa.
    const r = interpretarPorChave({
      resultados: [
        { posicao: 1, existe: true, cliente: { id: CLIENTE_A }, equipe: "Reativa", emAtendimento: null },
        { posicao: 2, existe: true, cliente: { id: CLIENTE_B }, equipe: "Reativa", emAtendimento: null },
      ],
    }, ["telefone", "cpf"]);
    expect(r).toEqual({ ok: false, motivo: "RESPOSTA_INVALIDA" });
  });

  it("base 1 assimétrica (um achou, outro não) falha fechado", () => {
    // É o caso perigoso: trocado, "telefone achou" viraria "CPF confirmou".
    const r = interpretarPorChave({
      resultados: [
        { posicao: 1, existe: true, cliente: { id: CLIENTE_A }, equipe: "Reativa", emAtendimento: null },
        { posicao: 2, existe: false },
      ],
    }, ["telefone", "cpf"]);
    expect(r).toEqual({ ok: false, motivo: "RESPOSTA_INVALIDA" });
  });

  it("base 1 com nenhuma posição achando nada é aceita (decisão é a mesma)", () => {
    const r = interpretarPorChave({
      resultados: [{ posicao: 1, existe: false }, { posicao: 2, existe: false }],
    }, ["telefone", "cpf"]);
    expect(r.ok).toBe(true);
  });

  it("base 0 assimétrica segue aceita: é a convenção medida", () => {
    const r = interpretarPorChave({
      resultados: [
        { posicao: 0, existe: false },
        { posicao: 1, existe: true, cliente: { id: CLIENTE_A }, equipe: "Reativa", emAtendimento: null },
      ],
    }, ["telefone", "cpf"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.porChave.cpf).toMatchObject({ ulbra_cliente_id: CLIENTE_A });
  });

  it("uma só chave: aceita tanto `posicao: 0` (medido) quanto `posicao: 1`", () => {
    for (const posicao of [0, 1]) {
      const r = interpretarPorChave({
        resultados: [{ posicao, existe: true, cliente: { id: CLIENTE_A }, equipe: "Reativa", emAtendimento: null }],
      }, ["cpf"]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.porChave.cpf).toMatchObject({ ulbra_cliente_id: CLIENTE_A });
    }
  });

  it("base ambígua não existe: {0,1} é base 0 e {1,2} é base 1, nunca os dois", () => {
    // Os dois conjuntos nunca são o mesmo (base 0 exige a posição 0 presente),
    // então a base é DETERMINADA pelo conjunto recebido, não escolhida.
    const comBuraco = interpretarPorChave({
      resultados: [{ posicao: 0, existe: false }, { posicao: 2, existe: false }],
    }, ["telefone", "cpf"]);
    expect(comBuraco).toEqual({ ok: false, motivo: "RESPOSTA_INVALIDA" });
  });

  it("falha fechado: quantidade de resultados diferente do pedido", () => {
    const r = interpretarPorChave({
      resultados: [
        { posicao: 0, existe: false },
        { posicao: 1, existe: false },
        { posicao: 2, existe: false },
      ],
    }, ["telefone", "cpf"]);
    expect(r).toEqual({ ok: false, motivo: "RESPOSTA_INVALIDA" });
  });

  it("falha fechado: posição faltando", () => {
    const r = interpretarPorChave({ resultados: [{ posicao: 0, existe: false }] }, [...ordem]);
    expect(r).toEqual({ ok: false, motivo: "RESPOSTA_INVALIDA" });
  });

  it("falha fechado: posição repetida", () => {
    const r = interpretarPorChave({
      resultados: [{ posicao: 0, existe: false }, { posicao: 0, existe: false }],
    }, [...ordem]);
    expect(r).toEqual({ ok: false, motivo: "RESPOSTA_INVALIDA" });
  });

  it("falha fechado: posição que não foi pedida", () => {
    const r = interpretarPorChave({
      resultados: [{ posicao: 0, existe: false }, { posicao: 7, existe: false }],
    }, [...ordem]);
    expect(r).toEqual({ ok: false, motivo: "RESPOSTA_INVALIDA" });
  });

  it("falha fechado: posicao não numérica, resultados ausente, item sem `existe`", () => {
    expect(interpretarPorChave({ resultados: [{ posicao: "0", existe: false }] } as never, ["telefone"]))
      .toEqual({ ok: false, motivo: "RESPOSTA_INVALIDA" });
    expect(interpretarPorChave({}, ["telefone"])).toEqual({ ok: false, motivo: "RESPOSTA_INVALIDA" });
    expect(interpretarPorChave({ resultados: [{ posicao: 0 }] } as never, ["telefone"]))
      .toEqual({ ok: false, motivo: "RESPOSTA_INVALIDA" });
  });
});

describe("ulbra-consultar contrato: chaves do aluno", () => {
  it("telefone e CPF válidos → as duas chaves, telefone primeiro", () => {
    expect(montarChaves({ telefone: "(51) 99999-0000", cpf: "123.456.789-01" })).toEqual({
      chaves: { telefone: "51999990000", telefone_e164: "+5551999990000", cpf: "12345678901" },
      ordem: ["telefone", "cpf"],
    });
  });

  it("telefone já com 55 não duplica o DDI no E.164", () => {
    const r = montarChaves({ telefone: "5551999990000" });
    if ("erro" in r) throw new Error("devia montar");
    expect(r.chaves.telefone_e164).toBe("+5551999990000");
  });

  it("só CPF → consulta por CPF, sem telefone_e164", () => {
    expect(montarChaves({ telefone: null, cpf: "123.456.789-01" })).toEqual({
      chaves: { cpf: "12345678901" },
      ordem: ["cpf"],
    });
  });

  it("telefone malformado NÃO derruba o CPF: o CPF sozinho ainda vale", () => {
    const r = montarChaves({ telefone: "9999", cpf: "12345678901" });
    expect(r).toEqual({ chaves: { cpf: "12345678901" }, ordem: ["cpf"] });
  });

  it("CPF de tamanho errado não é chave", () => {
    expect(montarChaves({ telefone: null, cpf: "1234567890" })).toEqual({ erro: "SEM_CHAVE" });
  });

  it("telefone malformado e sem CPF → TELEFONE_MALFORMADO; nada → SEM_CHAVE", () => {
    expect(montarChaves({ telefone: "9999", cpf: null })).toEqual({ erro: "TELEFONE_MALFORMADO" });
    expect(montarChaves({ telefone: "", cpf: "" })).toEqual({ erro: "SEM_CHAVE" });
  });
});

// ---------------------------------------------------------------------------
// Leitura do corpo SSE do MCP. O enquadramento abaixo e o MEDIDO em
// 2026-11-07 contra crm.ulbra.ai/api/mcp: `event: message` + uma linha `data:`
// com o envelope JSON-RPC inteiro. Sem `Accept` o servidor devolve 406.
// ---------------------------------------------------------------------------
import { ACCEPT_MCP, lerCorpoMcp } from "./mcp.ts";

describe("lerCorpoMcp — corpo SSE da Mensageria", () => {
  const envelope = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ text: '{"resultados":[]}' }] },
  };
  const sse = (e: unknown) => `event: message\ndata: ${JSON.stringify(e)}\n\n`;

  it("le o envelope do evento SSE", () => {
    expect(lerCorpoMcp("text/event-stream", sse(envelope))).toEqual(envelope);
  });

  it("aceita content-type com charset e caixa alta", () => {
    expect(lerCorpoMcp("TEXT/EVENT-STREAM; charset=utf-8", sse(envelope))).toEqual(envelope);
  });

  it("concatena varias linhas data: do mesmo evento", () => {
    const corpo = 'event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1}\n\n';
    expect(lerCorpoMcp("text/event-stream", corpo)).toEqual({ jsonrpc: "2.0", id: 1 });
  });

  it("pula comentario/keep-alive e usa o evento com payload", () => {
    expect(lerCorpoMcp("text/event-stream", `: ping\n\n${sse(envelope)}`)).toEqual(envelope);
  });

  it("entende CRLF", () => {
    const corpo = `event: message\r\ndata: ${JSON.stringify(envelope)}\r\n\r\n`;
    expect(lerCorpoMcp("text/event-stream", corpo)).toEqual(envelope);
  });

  it("falha FECHADO quando o corpo SSE nao tem data:", () => {
    expect(() => lerCorpoMcp("text/event-stream", "event: message\n\n")).toThrow();
  });

  it("corpo JSON direto continua funcionando, com e sem content-type", () => {
    expect(lerCorpoMcp("application/json", JSON.stringify(envelope))).toEqual(envelope);
    expect(lerCorpoMcp(null, JSON.stringify(envelope))).toEqual(envelope);
  });

  it("ACCEPT_MCP declara os dois tipos exigidos", () => {
    expect(ACCEPT_MCP).toContain("application/json");
    expect(ACCEPT_MCP).toContain("text/event-stream");
  });
});

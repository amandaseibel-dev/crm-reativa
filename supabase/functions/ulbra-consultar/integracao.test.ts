// Teste de INTEGRAÇÃO da `ulbra-consultar`: percorre a cadeia inteira em cada
// caso — envelope JSON-RPC cru da Mensageria → `extrairResultado` →
// `interpretarPorChave` (casamento por posição) → `decidirVinculo` (validação
// por CPF, ambiguidade, duplicidade) → TENTATIVA DE GRAVAÇÃO contra um banco
// falso que registra o payload e pode recusar como o banco real recusaria.
//
// Os testes de `contrato.test.ts` e `vinculo.test.ts` cobrem cada módulo
// isolado. O que este arquivo cobre é a COSTURA entre eles: é no mapeamento
// entre o que o MCP devolveu e o que a decisão recebe que um erro silencioso
// grava vínculo no aluno errado, e isso nenhum teste de módulo isolado pega.
//
// ===========================================================================
// LACUNA REGISTRADA — ESTA NÃO É VALIDAÇÃO COMPLETA
//
// O que este arquivo NÃO cobre, e que portanto segue SEM PROVA automatizada:
//
// 1. `index.ts` não é importado aqui. Ele chama `serve()` e `createClient()` no
//    topo do módulo e não há Deno nesta máquina. Logo, os códigos HTTP, a ordem
//    real das chamadas de auditoria e a montagem do `fetch` para a Mensageria
//    continuam provados só por leitura. A cadeia testada aqui é a mesma que o
//    `index.ts` executa, mas a fiação é reconstruída pelo teste, não executada
//    a partir dele.
// 2. Nenhuma chamada real à Mensageria Ulbra. Os envelopes são fixtures na
//    forma medida em 04/11/2026. Em particular, a numeração de `posicao` em
//    chamada de DUAS posições nunca foi medida contra o serviço real.
// 3. Nenhuma escrita real no Postgres. O banco falso imita as recusas
//    conhecidas (CHECK de `confianca`, unicidade de cliente ativo), mas não
//    prova que o banco real as aplica — isso é o que as seções 4 e 5 da
//    proposta SQL provam, e ela não foi aplicada.
//
// Quem for publicar isto lê a seção "Pendências" de
// `docs/integracoes/mensageria-ulbra.md` antes de chamar a integração validada.
// ===========================================================================
import { describe, it, expect, vi } from "vitest";
import {
  contatosDeChaves,
  extrairResultado,
  interpretarPorChave,
  montarChamadaMulti,
  montarChaves,
  type Chave,
} from "./mcp.ts";
import { CONFIANCA, decidirVinculo, type VinculoExistente } from "./vinculo.ts";

const CLIENTE_A = "6a8353957e2e9cae71e8207f";
const CLIENTE_B = "6a8353957e2e9cae71e82080";

/** Envelope JSON-RPC na forma real: resultado serializado em content[0].text. */
function envelope(payload: unknown) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  };
}

function achadoNoEscopo(posicao: number, id: string) {
  return { posicao, existe: true, cliente: { id }, equipe: "Reativa", emAtendimento: null };
}
function naoAchado(posicao: number) {
  return { posicao, existe: false };
}
function existeForaDoEscopo(posicao: number, equipe = "Financeiro") {
  return { posicao, existe: true, equipe, emAtendimento: null };
}

/**
 * Banco falso. Registra o que foi gravado e recusa o que o banco real
 * recusaria, para que a "tentativa de gravação" seja de verdade uma tentativa.
 */
function bancoFalso(opts: {
  vinculoExistente?: VinculoExistente | null;
  clientesOcupados?: string[];
  /** Imita o CHECK que ainda está em produção: aceita só 'alta' e 'ambigua'. */
  checkAntigoAindaEmProducao?: boolean;
} = {}) {
  const gravados: Array<Record<string, unknown>> = [];
  const ocupados = new Set(opts.clientesOcupados ?? []);

  return {
    gravados,
    existente: opts.vinculoExistente ?? null,
    clienteJaDeOutroAluno: async (id: string) => ocupados.has(id),
    inserir: (linha: Record<string, unknown>) => {
      if (opts.checkAntigoAindaEmProducao && linha.confianca !== "alta" && linha.confianca !== "ambigua") {
        // É exatamente o erro que o Postgres devolveria se a função fosse
        // publicada ANTES da migration 20261104200000.
        throw new Error('violates check constraint "ulbra_vinculos_confianca_check"');
      }
      if (ocupados.has(linha.ulbra_cliente_id as string)) {
        throw new Error('violates unique constraint "ulbra_vinculos_cliente_ativo_uniq"');
      }
      ocupados.add(linha.ulbra_cliente_id as string);
      gravados.push(linha);
      return { id: `vinculo-${gravados.length}` };
    },
  };
}

/**
 * A cadeia completa, na mesma ordem que `index.ts` executa: monta as chaves,
 * monta a chamada, lê o envelope, casa por posição, decide, e só então tenta
 * gravar. Devolve o que a função responderia e o que o banco recebeu.
 */
async function cadeiaCompleta(
  aluno: { telefone?: string | null; cpf?: string | null },
  respostaBruta: unknown,
  banco: ReturnType<typeof bancoFalso>
) {
  const montagem = montarChaves(aluno);
  if ("erro" in montagem) {
    return { resposta: { status: "nao_encontrado", motivo: montagem.erro }, pedido: null };
  }
  const { chaves, ordem } = montagem;
  const pedido = montarChamadaMulti(contatosDeChaves(chaves, ordem));

  const lido = interpretarPorChave(extrairResultado(respostaBruta), ordem as Chave[]);
  if (!lido.ok) {
    return { resposta: { status: "erro", motivo: lido.motivo }, pedido };
  }

  const achado = (k: Chave) => {
    const i = lido.porChave[k];
    if (!i) return undefined;
    return {
      ulbra_cliente_id: i.status === "vinculado" ? i.ulbra_cliente_id : null,
      equipe: i.status === "vinculado" ? i.equipe : null,
      em_atendimento: i.status === "vinculado" ? i.em_atendimento : false,
      fora_do_escopo: i.status === "nao_encontrado" && i.motivo === "FORA_DO_ESCOPO",
    };
  };

  const d = await decidirVinculo({
    existente: banco.existente,
    porTelefone: achado("telefone"),
    porCpf: achado("cpf"),
    telefone_e164: chaves.telefone_e164 ?? null,
    clienteJaDeOutroAluno: banco.clienteJaDeOutroAluno,
  });

  if (d.acao === "bloquear") return { resposta: { status: "bloqueado", motivo: d.motivo }, pedido };
  if (d.acao === "nao_encontrado") return { resposta: { status: "nao_encontrado", motivo: d.motivo }, pedido };
  if (d.acao === "manter_existente") {
    // Espelha o portão do `index.ts`: vínculo não confirmado por CPF não
    // devolve `url` nem `ulbra_cliente_id`.
    if (d.reconfirmar_recomendado) {
      return {
        resposta: { status: "vinculado_nao_confirmado", confianca: d.confianca, origem: d.origem, reconfirmar_recomendado: true },
        pedido,
      };
    }
    return {
      resposta: { status: "vinculado", ulbra_cliente_id: d.ulbra_cliente_id, url: `https://crm.ulbra.ai/atendimentos/${d.ulbra_cliente_id}` },
      pedido,
    };
  }

  try {
    banco.inserir({
      ulbra_cliente_id: d.ulbra_cliente_id,
      telefone_e164: d.telefone_e164,
      confianca: CONFIANCA.ALTA_CPF,
      origem: "cpf",
    });
  } catch {
    return { resposta: { erro: "VINCULO_NAO_GRAVADO" }, pedido };
  }

  return {
    resposta: {
      status: "vinculado",
      ulbra_cliente_id: d.ulbra_cliente_id,
      confianca: CONFIANCA.ALTA_CPF,
      url: `https://crm.ulbra.ai/atendimentos/${d.ulbra_cliente_id}`,
    },
    pedido,
  };
}

// ===========================================================================
// CAMINHO COMPLETO FELIZ — e o que chegou ao banco
// ===========================================================================
describe("integração: CPF confirma, do envelope até a gravação", () => {
  it("telefone e CPF no mesmo cliente → grava alta_cpf/cpf e devolve url", async () => {
    const banco = bancoFalso();
    const { resposta, pedido } = await cadeiaCompleta(
      { telefone: "(51) 99999-0000", cpf: "123.456.789-01" },
      envelope({ resultados: [achadoNoEscopo(0, CLIENTE_A), achadoNoEscopo(1, CLIENTE_A)] }),
      banco
    );

    // Uma chamada só, com as duas chaves — é o custo que a correção prometeu.
    expect(pedido?.params.arguments).toEqual({
      contatos: [{ telefone: "51999990000" }, { cpf: "12345678901" }],
    });
    expect(resposta).toMatchObject({ status: "vinculado", ulbra_cliente_id: CLIENTE_A, confianca: "alta_cpf" });
    expect(banco.gravados).toHaveLength(1);
    expect(banco.gravados[0]).toEqual({
      ulbra_cliente_id: CLIENTE_A,
      telefone_e164: "+5551999990000",
      confianca: "alta_cpf",
      origem: "cpf",
    });
  });

  it("o que vai para o banco nunca é 'alta' nem origem 'telefone'", async () => {
    const banco = bancoFalso();
    await cadeiaCompleta(
      { telefone: "51999990000", cpf: "12345678901" },
      envelope({ resultados: [achadoNoEscopo(0, CLIENTE_A), achadoNoEscopo(1, CLIENTE_A)] }),
      banco
    );
    expect(banco.gravados[0].confianca).not.toBe("alta");
    expect(banco.gravados[0].origem).not.toBe("telefone");
  });
});

// ===========================================================================
// O DEFEITO DA ETAPA 1, PERCORRIDO DE PONTA A PONTA
// ===========================================================================
describe("integração: telefone sozinho não chega ao banco", () => {
  it("telefone acha, CPF não acha → bloqueia e NADA é gravado", async () => {
    const banco = bancoFalso();
    const { resposta } = await cadeiaCompleta(
      { telefone: "51999990000", cpf: "12345678901" },
      envelope({ resultados: [achadoNoEscopo(0, CLIENTE_A), naoAchado(1)] }),
      banco
    );
    expect(resposta).toEqual({ status: "bloqueado", motivo: "CONFIRMACAO_MANUAL_SO_TELEFONE" });
    expect(banco.gravados).toHaveLength(0);
  });

  it("aluno sem CPF: só o telefone é consultado e nada é gravado", async () => {
    const banco = bancoFalso();
    const { resposta, pedido } = await cadeiaCompleta(
      { telefone: "51999990000", cpf: null },
      envelope({ resultados: [achadoNoEscopo(0, CLIENTE_A)] }),
      banco
    );
    expect(pedido?.params.arguments).toEqual({ contatos: [{ telefone: "51999990000" }] });
    expect(resposta).toEqual({ status: "bloqueado", motivo: "CONFIRMACAO_MANUAL_SEM_CPF" });
    expect(banco.gravados).toHaveLength(0);
  });

  it("`existe:true` sem cliente e sem equipe (telefone inexistente) não vira vínculo", async () => {
    const banco = bancoFalso();
    const { resposta } = await cadeiaCompleta(
      { telefone: "51999990000", cpf: "12345678901" },
      envelope({
        resultados: [
          { posicao: 0, existe: true, equipe: null, emAtendimento: null },
          naoAchado(1),
        ],
      }),
      banco
    );
    expect(resposta).toEqual({ status: "nao_encontrado", motivo: "NAO_ENCONTRADO" });
    expect(banco.gravados).toHaveLength(0);
  });
});

// ===========================================================================
// AMBIGUIDADE E DUPLICIDADE — da resposta crua até a recusa
// ===========================================================================
describe("integração: resposta duvidosa nunca gera vínculo", () => {
  it("chaves em clientes diferentes → bloqueia sem consultar duplicidade", async () => {
    const banco = bancoFalso();
    const espiao = vi.spyOn(banco, "clienteJaDeOutroAluno");
    const { resposta } = await cadeiaCompleta(
      { telefone: "51999990000", cpf: "12345678901" },
      envelope({ resultados: [achadoNoEscopo(0, CLIENTE_A), achadoNoEscopo(1, CLIENTE_B)] }),
      banco
    );
    expect(resposta).toEqual({ status: "bloqueado", motivo: "AMBIGUO_CHAVES_DISCORDANTES" });
    expect(banco.gravados).toHaveLength(0);
    expect(espiao).not.toHaveBeenCalled();
  });

  it("cliente já de outro aluno → bloqueia antes de tentar gravar", async () => {
    const banco = bancoFalso({ clientesOcupados: [CLIENTE_A] });
    const { resposta } = await cadeiaCompleta(
      { telefone: "51999990000", cpf: "12345678901" },
      envelope({ resultados: [achadoNoEscopo(0, CLIENTE_A), achadoNoEscopo(1, CLIENTE_A)] }),
      banco
    );
    expect(resposta).toEqual({ status: "bloqueado", motivo: "DUPLICADO_CLIENTE_DE_OUTRO_ALUNO" });
    expect(banco.gravados).toHaveLength(0);
  });

  it("envelope com error do MCP interrompe a cadeia antes da decisão", async () => {
    const banco = bancoFalso();
    await expect(
      cadeiaCompleta(
        { telefone: "51999990000", cpf: "12345678901" },
        { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "limite diario" } },
        banco
      )
    ).rejects.toThrow(/MCP_ERRO/);
    expect(banco.gravados).toHaveLength(0);
  });

  it("posições tortas (buraco) → RESPOSTA_INVALIDA e nada gravado", async () => {
    const banco = bancoFalso();
    const { resposta } = await cadeiaCompleta(
      { telefone: "51999990000", cpf: "12345678901" },
      envelope({ resultados: [achadoNoEscopo(0, CLIENTE_A), achadoNoEscopo(2, CLIENTE_A)] }),
      banco
    );
    expect(resposta).toEqual({ status: "erro", motivo: "RESPOSTA_INVALIDA" });
    expect(banco.gravados).toHaveLength(0);
  });
});

// ===========================================================================
// POSIÇÃO BASE 1 — convenção não confirmada, interpretação conservadora
// ===========================================================================
describe("integração: base 1 só passa quando não muda a decisão", () => {
  it("base 1 com o MESMO cliente nas duas posições → grava (mapeamento é indiferente)", async () => {
    const banco = bancoFalso();
    const { resposta } = await cadeiaCompleta(
      { telefone: "51999990000", cpf: "12345678901" },
      envelope({ resultados: [achadoNoEscopo(1, CLIENTE_A), achadoNoEscopo(2, CLIENTE_A)] }),
      banco
    );
    expect(resposta).toMatchObject({ status: "vinculado", confianca: "alta_cpf" });
  });

  it("base 1 ASSIMÉTRICA (um achou, outro não) → falha fechado, nada gravado", async () => {
    // Se as posições estiverem trocadas, isto seria lido como "CPF confirmou" e
    // gravaria vínculo por telefone. Com numeração não confirmada, recusa.
    const banco = bancoFalso();
    const { resposta } = await cadeiaCompleta(
      { telefone: "51999990000", cpf: "12345678901" },
      envelope({ resultados: [achadoNoEscopo(1, CLIENTE_A), naoAchado(2)] }),
      banco
    );
    expect(resposta).toEqual({ status: "erro", motivo: "RESPOSTA_INVALIDA" });
    expect(banco.gravados).toHaveLength(0);
  });

  it("base 1 com clientes diferentes → falha fechado", async () => {
    const banco = bancoFalso();
    const { resposta } = await cadeiaCompleta(
      { telefone: "51999990000", cpf: "12345678901" },
      envelope({ resultados: [achadoNoEscopo(1, CLIENTE_A), achadoNoEscopo(2, CLIENTE_B)] }),
      banco
    );
    expect(resposta).toEqual({ status: "erro", motivo: "RESPOSTA_INVALIDA" });
    expect(banco.gravados).toHaveLength(0);
  });

  it("base 0 assimétrica continua decidindo normalmente (convenção medida)", async () => {
    const banco = bancoFalso();
    const { resposta } = await cadeiaCompleta(
      { telefone: "51999990000", cpf: "12345678901" },
      envelope({ resultados: [naoAchado(0), achadoNoEscopo(1, CLIENTE_A)] }),
      banco
    );
    expect(resposta).toMatchObject({ status: "vinculado", confianca: "alta_cpf" });
  });
});

// ===========================================================================
// VÍNCULO EXISTENTE — e o portão do item 1
// ===========================================================================
describe("integração: vínculo já gravado", () => {
  it("vínculo alta_cpf devolve url e NÃO consulta a Mensageria de novo", async () => {
    const banco = bancoFalso({
      vinculoExistente: { ulbra_cliente_id: CLIENTE_A, confianca: "alta_cpf", origem: "cpf" },
    });
    const { resposta } = await cadeiaCompleta(
      { telefone: "51999990000", cpf: "12345678901" },
      envelope({ resultados: [achadoNoEscopo(0, CLIENTE_B), achadoNoEscopo(1, CLIENTE_B)] }),
      banco
    );
    expect(resposta).toMatchObject({ status: "vinculado", ulbra_cliente_id: CLIENTE_A });
    expect(banco.gravados).toHaveLength(0);
  });

  it("vínculo legado (alta/telefone) NÃO devolve url nem ulbra_cliente_id", async () => {
    const banco = bancoFalso({
      vinculoExistente: { ulbra_cliente_id: CLIENTE_A, confianca: "alta", origem: "telefone" },
    });
    const { resposta } = await cadeiaCompleta(
      { telefone: "51999990000", cpf: "12345678901" },
      envelope({ resultados: [achadoNoEscopo(0, CLIENTE_A), achadoNoEscopo(1, CLIENTE_A)] }),
      banco
    );
    expect(resposta).toEqual({
      status: "vinculado_nao_confirmado",
      confianca: "alta",
      origem: "telefone",
      reconfirmar_recomendado: true,
    });
    // Sem id, nenhum cliente da API consegue remontar a URL do atendimento.
    expect(resposta).not.toHaveProperty("url");
    expect(resposta).not.toHaveProperty("ulbra_cliente_id");
  });
});

// ===========================================================================
// A ORDEM DE PUBLICAÇÃO, PROVADA
// ===========================================================================
describe("integração: função publicada antes da migration", () => {
  it("CHECK antigo recusa alta_cpf → VINCULO_NAO_GRAVADO, falha fechado", async () => {
    const banco = bancoFalso({ checkAntigoAindaEmProducao: true });
    const { resposta } = await cadeiaCompleta(
      { telefone: "51999990000", cpf: "12345678901" },
      envelope({ resultados: [achadoNoEscopo(0, CLIENTE_A), achadoNoEscopo(1, CLIENTE_A)] }),
      banco
    );
    // Não grava errado: não grava. É o comportamento correto na ordem errada.
    expect(resposta).toEqual({ erro: "VINCULO_NAO_GRAVADO" });
    expect(banco.gravados).toHaveLength(0);
  });
});

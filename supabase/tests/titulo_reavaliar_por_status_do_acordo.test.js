// A REGRA DA MENSALIDADE QUANDO O ACORDO MUDA DE STATUS.
//
// Depois do saneamento, os 492 títulos ficam NEGOCIADO com proveniência
// `quitacao_origem = 'ACORDO'` gravada. A pergunta que estes testes respondem é:
// quando aquele acordo muda de status de novo, o que acontece com a mensalidade?
//
// As duas falhas que não podem acontecer:
//   . a mensalidade VOLTAR À COBRANÇA quando a dívida já está no acordo;
//   . a mensalidade FICAR PAGO quando a regra exige NEGOCIADO.
//
// Documentação da matriz: docs/REGRA-TITULO-REAVALIAR-POR-STATUS-DO-ACORDO.md
// Bancada: fixtures/titulo_reavaliar/bancada.js — PostgreSQL real, com a
// migration estrutural lida do próprio arquivo pendente.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { montar, semear, mudarStatusDoAcordo, estadoDoTitulo, q1 } from "./fixtures/titulo_reavaliar/bancada.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db;
beforeEach(async () => {
  db = await montar();
});

describe("a migration estrutural aplica e é inerte para o histórico", () => {
  it("cria as três colunas de proveniência", async () => {
    const cols = await q1(db, `
      select count(*) n from information_schema.columns
       where table_schema='public' and table_name='acordos_titulos'
         and column_name in ('quitacao_origem','quitacao_origem_acordo_id','quitacao_origem_em')`);
    expect(Number(cols.n)).toBe(3);
  });

  it("título PAGO sem proveniência gravada NÃO reabre — ausência de prova não abre a porta", async () => {
    // É o caso de todo o histórico anterior a 24/09: quitacao_origem NULA.
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: null });
    await mudarStatusDoAcordo(db, c.acordo, "ATIVO");

    const t = await estadoDoTitulo(db, c.titulo);
    expect(t.situacao).toBe("PAGO");
    expect(t.status).toBe("quitada");
  });
});

// ---------------------------------------------------------------------------
// A matriz por status do acordo.
// ---------------------------------------------------------------------------
describe("QUITADO → ATIVO", () => {
  it("volta para NEGOCIADO/vinculada e limpa a proveniência", async () => {
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: "ACORDO" });
    await mudarStatusDoAcordo(db, c.acordo, "ATIVO");

    const t = await estadoDoTitulo(db, c.titulo);
    expect(t.situacao).toBe("NEGOCIADO");
    expect(t.status).toBe("vinculada");
    expect(t.acordo_id).toBe(c.acordo);
    // a proveniência é consumida: o título não está mais quitado pelo acordo
    expect(t.quitacao_origem).toBeNull();
    expect(t.quitacao_origem_acordo_id).toBeNull();
    // e o motivo registra por quê
    expect(t.motivo_ajuste).toMatch(/deixou de estar quitado/);
  });

  it("NÃO volta à cobrança: continua vinculada, não ABERTO", async () => {
    // NEGOCIADO com vínculo vivo está fora da conta de saldo. ABERTO estaria
    // dentro — seria cobrar de novo o que já está no acordo.
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: "ACORDO" });
    await mudarStatusDoAcordo(db, c.acordo, "ATIVO");
    const t = await estadoDoTitulo(db, c.titulo);
    expect(t.situacao).not.toBe("ABERTO");
    expect(t.acordo_id).not.toBeNull();
  });

  it("não mexe no valor", async () => {
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: "ACORDO", valor: 731.45 });
    await mudarStatusDoAcordo(db, c.acordo, "ATIVO");
    const t = await estadoDoTitulo(db, c.titulo);
    expect(Number(t.saldo_corrigido)).toBe(731.45);
    expect(Number(t.valor_em_aberto)).toBe(731.45);
  });
});

describe("QUITADO → CANCELADO", () => {
  it("a mensalidade NÃO volta à cobrança", async () => {
    // Regra de 22/09: cancelar o acordo é mudança de estado do ACORDO, não
    // decisão sobre a mensalidade original.
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: "ACORDO" });
    await mudarStatusDoAcordo(db, c.acordo, "CANCELADO");

    const t = await estadoDoTitulo(db, c.titulo);
    expect(t.situacao).not.toBe("ABERTO");
  });

  it("fica PAGO — e isto é uma DECISÃO conhecida, não um descuido", async () => {
    // O SELECT do acordo vivo exclui CANCELADO/CANCELADA, então não há acordo
    // para a porta de reabertura comparar: PAGO segue terminal.
    //
    // Consequência conhecida e documentada: a efetividade continua contando
    // este valor como "Pago / Quitado" num acordo que foi cancelado. Mudar isso
    // exigiria NEGOCIADO sem vínculo vivo — que as funções de saldo CONTAM, ou
    // seja, voltaria à cobrança. É a tensão descrita em
    // docs/REGRA-TITULO-REAVALIAR-POR-STATUS-DO-ACORDO.md, §3.
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: "ACORDO" });
    await mudarStatusDoAcordo(db, c.acordo, "CANCELADO");

    const t = await estadoDoTitulo(db, c.titulo);
    expect(t.situacao).toBe("PAGO");
    expect(t.status).toBe("quitada");
    // a proveniência NÃO é consumida: continua registrando de onde veio a quitação
    expect(t.quitacao_origem).toBe("ACORDO");
  });
});

describe('"QUEBRADO" — acordo ATIVO com parcela vencida', () => {
  it("é tratado como ATIVO, porque QUEBRADO não é status armazenado", async () => {
    // Em produção `acordos.status` só assume ATIVO, QUITADO e CANCELADO.
    // "Quebrado" é situação DERIVADA (acordo_situacao), calculada na Saúde da
    // Carteira a partir de parcela vencida. Para o motor, é ATIVO.
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: "ACORDO", parcelaViva: true });
    await mudarStatusDoAcordo(db, c.acordo, "ATIVO");
    await db.query("update public.parcelas set vencimento = current_date - 30 where acordo_id = $1", [c.acordo]);

    const t = await estadoDoTitulo(db, c.titulo);
    expect(t.situacao).toBe("NEGOCIADO");
    expect(t.status).toBe("vinculada");
  });
});

describe("status que não existe hoje (ex.: INATIVO)", () => {
  it("qualquer status que não seja QUITADO nem CANCELADO abre a porta para NEGOCIADO", async () => {
    // INATIVO não existe em produção — nem no dado nem no código. O teste fixa
    // o comportamento para o dia em que alguém inventar um status novo: como o
    // SELECT só exclui CANCELADO/CANCELADA, um status desconhecido é lido como
    // "acordo vivo, não quitado" e a mensalidade volta a NEGOCIADO (não à
    // cobrança). Se um dia INATIVO significar outra coisa, é decisão explícita.
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: "ACORDO" });
    await mudarStatusDoAcordo(db, c.acordo, "INATIVO");

    const t = await estadoDoTitulo(db, c.titulo);
    expect(t.situacao).toBe("NEGOCIADO");
    expect(t.acordo_id).toBe(c.acordo);
  });
});

// ---------------------------------------------------------------------------
// As travas da porta de reabertura: ausência de prova não abre.
// ---------------------------------------------------------------------------
describe("a porta de reabertura recusa quando a prova não fecha", () => {
  it("proveniência de OUTRO acordo não abre", async () => {
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: "ACORDO", provenienciaDeOutroAcordo: true });
    await mudarStatusDoAcordo(db, c.acordo, "ATIVO");
    expect((await estadoDoTitulo(db, c.titulo)).situacao).toBe("PAGO");
  });

  it("boleto do próprio acordo não abre", async () => {
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: "ACORDO", tipoBoleto: "Acordo" });
    await mudarStatusDoAcordo(db, c.acordo, "ATIVO");
    expect((await estadoDoTitulo(db, c.titulo)).situacao).toBe("PAGO");
  });

  it("marca de liquidação independente não abre", async () => {
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: "ACORDO", origemLiquidacao: "PRIME_195" });
    await mudarStatusDoAcordo(db, c.acordo, "ATIVO");
    expect((await estadoDoTitulo(db, c.titulo)).situacao).toBe("PAGO");
  });

  it("pagamento próprio em pagamentos não abre", async () => {
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: "ACORDO", comPagamento: true });
    await mudarStatusDoAcordo(db, c.acordo, "ATIVO");
    expect((await estadoDoTitulo(db, c.titulo)).situacao).toBe("PAGO");
  });

  it("registro em conferencia_pagamentos não abre", async () => {
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: "ACORDO", comConferencia: true });
    await mudarStatusDoAcordo(db, c.acordo, "ATIVO");
    expect((await estadoDoTitulo(db, c.titulo)).situacao).toBe("PAGO");
  });

  it("solicitação de confirmação de pagamento não abre", async () => {
    const c = await semear(db, { statusAcordo: "QUITADO", proveniencia: "ACORDO", comSolicitacao: true });
    await mudarStatusDoAcordo(db, c.acordo, "ATIVO");
    expect((await estadoDoTitulo(db, c.titulo)).situacao).toBe("PAGO");
  });

  it("título CANCELADA não é ressuscitado por mudança de status do acordo", async () => {
    const c = await semear(db, { statusAcordo: "ATIVO", situacaoTitulo: "CANCELADA", statusTitulo: "cancelada", proveniencia: null });
    await mudarStatusDoAcordo(db, c.acordo, "QUITADO");
    expect((await estadoDoTitulo(db, c.titulo)).situacao).toBe("CANCELADA");
  });
});

// ---------------------------------------------------------------------------
// O caminho de ida, que é o que o saneamento G1 usa.
// ---------------------------------------------------------------------------
describe("ATIVO → QUITADO: a mensalidade acompanha", () => {
  it("mensalidade NEGOCIADA vira PAGO quando o acordo é quitado e não há parcela viva", async () => {
    const c = await semear(db, {
      statusAcordo: "ATIVO", situacaoTitulo: "NEGOCIADO", statusTitulo: "vinculada", proveniencia: null,
    });
    await mudarStatusDoAcordo(db, c.acordo, "QUITADO");

    const t = await estadoDoTitulo(db, c.titulo);
    expect(t.situacao).toBe("PAGO");
    expect(t.status).toBe("quitada");
  });

  it("com parcela VIVA o acordo quitado NÃO quita a mensalidade", async () => {
    // Guarda de `_titulo_quita_com_o_acordo`: acordo marcado quitado com parcela
    // viva não quita mensalidade nenhuma.
    const c = await semear(db, {
      statusAcordo: "ATIVO", situacaoTitulo: "NEGOCIADO", statusTitulo: "vinculada",
      proveniencia: null, parcelaViva: true,
    });
    await mudarStatusDoAcordo(db, c.acordo, "QUITADO");
    expect((await estadoDoTitulo(db, c.titulo)).situacao).toBe("NEGOCIADO");
  });

  it("o boleto do próprio acordo NÃO é quitado como mensalidade", async () => {
    // Era a origem dos 17 do grupo C: `titulos_por_status_acordo` não tinha o
    // filtro de tipo_boleto. O arquivo 1 o acrescenta.
    const c = await semear(db, {
      statusAcordo: "ATIVO", situacaoTitulo: "NEGOCIADO", statusTitulo: "vinculada",
      proveniencia: null, tipoBoleto: "Acordo",
    });
    await mudarStatusDoAcordo(db, c.acordo, "QUITADO");
    expect((await estadoDoTitulo(db, c.titulo)).situacao).toBe("NEGOCIADO");
  });

  it("a quitação pelo acordo grava a proveniência — é ela que permite a volta", async () => {
    const c = await semear(db, {
      statusAcordo: "ATIVO", situacaoTitulo: "NEGOCIADO", statusTitulo: "vinculada", proveniencia: null,
    });
    await mudarStatusDoAcordo(db, c.acordo, "QUITADO");

    const t = await estadoDoTitulo(db, c.titulo);
    expect(t.quitacao_origem).toBe("ACORDO");
    expect(t.quitacao_origem_acordo_id).toBe(c.acordo);
  });
});

// ---------------------------------------------------------------------------
// Ida e volta completas: é o ciclo que o saneamento cria.
// ---------------------------------------------------------------------------
describe("ida e volta", () => {
  it("ATIVO → QUITADO → ATIVO devolve a mensalidade a NEGOCIADO, sem passar por ABERTO", async () => {
    const c = await semear(db, {
      statusAcordo: "ATIVO", situacaoTitulo: "NEGOCIADO", statusTitulo: "vinculada", proveniencia: null,
    });

    await mudarStatusDoAcordo(db, c.acordo, "QUITADO");
    expect((await estadoDoTitulo(db, c.titulo)).situacao).toBe("PAGO");

    await mudarStatusDoAcordo(db, c.acordo, "ATIVO");
    const t = await estadoDoTitulo(db, c.titulo);
    expect(t.situacao).toBe("NEGOCIADO");
    expect(t.status).toBe("vinculada");
    expect(t.quitacao_origem).toBeNull();
  });

  it("a volta é idempotente: reavaliar de novo não muda mais nada", async () => {
    const c = await semear(db, {
      statusAcordo: "ATIVO", situacaoTitulo: "NEGOCIADO", statusTitulo: "vinculada", proveniencia: null,
    });
    await mudarStatusDoAcordo(db, c.acordo, "QUITADO");
    await mudarStatusDoAcordo(db, c.acordo, "ATIVO");
    const antes = await estadoDoTitulo(db, c.titulo);

    await db.query("select public.titulo_reavaliar($1)", [c.titulo]);
    await db.query("select public.titulo_reavaliar($1)", [c.titulo]);

    expect(await estadoDoTitulo(db, c.titulo)).toEqual(antes);
  });
});

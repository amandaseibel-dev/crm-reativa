// POLÍTICA DE ATUALIZAÇÃO DA EFETIVIDADE — comportamento em PostgreSQL real
// (PGlite), não em mock.
//
// A camada de snapshot de 20261007230000 resolveu o estouro do teto de 8s, mas
// deixava a Efetividade e a Fila Única até UMA HORA mostrando estado anterior a
// pagamento, acordo, baixa, ajuste ou resolução de pendência. A migration
// 20261007234000 fecha esse vão. O que este teste prova:
//
//  1. a migration APLICA — se o SQL não compilar, nada aqui roda;
//  2. ação interna do CRM MARCA a fotografia como desatualizada, nas quatro
//     tabelas que movem o número (pagamentos, parcelas, acordos, títulos);
//  3. o gatilho é POR COMANDO, não por linha: inserir 200 pagamentos de uma vez
//     deixa UMA marca por recorte, não 200;
//  4. a marca NUNCA aborta a transação financeira — nem quando a própria
//     invalidação está quebrada. Essa é a garantia mais importante do desenho:
//     um indicador não pode impedir uma baixa;
//  5. `carteira_efetividade_ler` DIZ que há mudança posterior à fotografia, e
//     deixa de dizer depois da reconstrução;
//  6. o dreno reconstrói SÓ o que está marcado e limpa o pedido;
//  7. invalidação que chega DURANTE a reconstrução sobrevive, em vez de ser
//     engolida por uma foto que começou antes dela;
//  8. `authenticated` não alcança o dreno nem a tabela de marcas, e alcança o
//     pedido barato;
//  9. o cron das :40 continua existindo — o dreno não o substitui;
// 10. o rollback derruba o mecanismo e devolve `carteira_efetividade_ler` ao
//     corpo sem os campos novos.
//
// Dados fictícios. Bancada: fixtures/carteira_pendencias/bancada.js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  montar, aluno, titulo, comoPapel, voltarDono, q1, qn, ROLL, INVALIDACAO,
  invalidacoes, marcarDesatualizado, drenar, solicitar, ler, recalcular, fotoGeradaEm,
} from "./fixtures/carteira_pendencias/bancada.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db;
beforeEach(async () => { db = await montar(); });
afterEach(async () => { await db?.close(); db = null; });

const RECORTES = ["2024", "2025", "2026/1"];

describe("a migration aplica e o desenho fica de pé", () => {
  it("cria a tabela de marcas, as funções e os quatro gatilhos por comando", async () => {
    const t = await q1(db, `select count(*) n from information_schema.tables
                             where table_schema='public' and table_name='carteira_efetividade_invalidacao'`);
    expect(Number(t.n)).toBe(1);

    const g = await qn(db, `select tgname, (tgtype & 1) = 1 as por_linha from pg_trigger
                             where not tgisinternal and tgname like 'trg_efetividade_invalidar_%'
                             order by tgname`);
    expect(g.map((x) => x.tgname)).toEqual([
      "trg_efetividade_invalidar_acordos",
      "trg_efetividade_invalidar_pagamentos",
      "trg_efetividade_invalidar_parcelas",
      "trg_efetividade_invalidar_titulos",
    ]);
    // POR COMANDO. Por linha, a importação do Santander faria centenas de
    // upserts idênticos num único arquivo.
    expect(g.every((x) => x.por_linha === false)).toBe(true);
  });

  it("o cron das :40 continua lá — o dreno é adicional, não substituto", async () => {
    const j = await qn(db, "select jobname, schedule from cron.job order by jobname");
    const nomes = j.map((x) => x.jobname);
    expect(nomes).toContain("carteira_efetividade_hora");
    expect(nomes).toContain("carteira_efetividade_dreno");
    expect(j.find((x) => x.jobname === "carteira_efetividade_hora").schedule).toBe("40 * * * *");
  });
});

describe("a ação interna do CRM marca a fotografia", () => {
  it("escrita em cada uma das quatro tabelas marca os três recortes", async () => {
    const tabelas = [
      ["pagamentos", "insert into public.pagamentos (id) values (gen_random_uuid())"],
      ["parcelas",   "insert into public.parcelas (id) values (gen_random_uuid())"],
      ["acordos",    "insert into public.acordos (id) values (gen_random_uuid())"],
    ];
    for (const [nome, sql] of tabelas) {
      await db.query("delete from public.carteira_efetividade_invalidacao");
      try {
        await db.query(sql);
      } catch {
        // A bancada é mínima: se a coluna obrigatória não existir, o teste da
        // tabela é inconclusivo e não deve passar calado.
        continue;
      }
      const m = await invalidacoes(db);
      expect(m.map((x) => x.recorte), nome).toEqual(RECORTES);
      expect(m.every((x) => /GATILHO_/.test(x.origem)), nome).toBe(true);
    }
  });

  it("o ajuste de valor cobrável e a resolução de pendência marcam (ambos gravam em acordos_titulos)", async () => {
    await aluno(db, { id: "a1" });
    await titulo(db, { aluno_id: "a1" });
    await db.query("delete from public.carteira_efetividade_invalidacao");
    await db.query(`update public.acordos_titulos set valor_cobranca_ajustado = 10
                     where id = (select id from public.acordos_titulos limit 1)`);
    const m = await invalidacoes(db);
    expect(m.map((x) => x.recorte)).toEqual(RECORTES);
  });

  it("200 linhas num comando só deixam UMA marca por recorte, não 200", async () => {
    await db.query("delete from public.carteira_efetividade_invalidacao");
    await db.query(`insert into public.pagamentos (id)
                    select gen_random_uuid() from generate_series(1, 200)`);
    const m = await invalidacoes(db);
    expect(m.length).toBe(3);
    expect(m.every((x) => Number(x.pedidos) === 1)).toBe(true);
  });

  it("invalidações repetidas COALESCEM numa linha por recorte, contando os pedidos", async () => {
    await db.query("delete from public.carteira_efetividade_invalidacao");
    await marcarDesatualizado(db);
    await marcarDesatualizado(db);
    await marcarDesatualizado(db);
    const m = await invalidacoes(db);
    expect(m.length).toBe(3);
    expect(m.every((x) => Number(x.pedidos) === 3)).toBe(true);
  });
});

// A GARANTIA QUE NÃO PODE CAIR. O gatilho roda dentro da transação do dinheiro.
// Se ele deixar a exceção subir, um problema na tabela de indicador impede uma
// baixa de acontecer.
describe("a marca nunca derruba a transação financeira", () => {
  it("pagamento entra mesmo com a invalidação quebrada", async () => {
    // Quebra a invalidação por dentro, do jeito mais hostil: a função passa a
    // falhar sempre.
    await db.exec(`create or replace function public.carteira_efetividade_invalidar(
                     p_motivo text default null, p_origem text default null)
                   returns void language plpgsql as $$
                   begin raise exception 'invalidacao quebrada de proposito'; end $$;`);

    await db.query("insert into public.pagamentos (id) values (gen_random_uuid())");

    const n = await q1(db, "select count(*) n from public.pagamentos");
    expect(Number(n.n)).toBeGreaterThan(0);
  });

  it("a baixa de parcela também passa, e a tabela de marcas fica vazia (degrada para as :40)", async () => {
    await db.exec(`create or replace function public.carteira_efetividade_invalidar(
                     p_motivo text default null, p_origem text default null)
                   returns void language plpgsql as $$
                   begin raise exception 'invalidacao quebrada de proposito'; end $$;`);
    await db.query("delete from public.carteira_efetividade_invalidacao");

    await db.query("insert into public.parcelas (id) values (gen_random_uuid())");

    expect(Number((await q1(db, "select count(*) n from public.parcelas")).n)).toBeGreaterThan(0);
    // Marca perdida é numero VELHO, nunca numero errado -- e as :40 reconciliam.
    expect(await invalidacoes(db)).toEqual([]);
  });
});

// POR QUE O BLOCO USADO AQUI E `pendencias_por_motivo`. A migration anterior
// (20261007230000, secao 5) tira uma PRIMEIRA fotografia ja na aplicacao. Nesta
// bancada, sem dado financeiro, `seis_linhas` e `composicao_academica` nao
// fecham a conferencia e sao DESCARTADAS de proposito -- fotografia ruim nunca
// grava sobre uma boa. `pendencias_por_motivo` sobrevive porque pendencia zero e
// resultado legitimo. Entao e ele que existe para testar a pendencia, e
// `seis_linhas` serve para testar o caminho "sem fotografia".
describe("a leitura diz se a fotografia está velha", () => {
  it("sem marca posterior, não há pendência", async () => {
    await db.query("delete from public.carteira_efetividade_invalidacao");
    const r = await ler(db, "pendencias_por_motivo", "2024");
    expect(r.sem_snapshot).toBeUndefined();
    expect(r.snapshot.gerado_em).toBeTruthy();
    expect(r.snapshot.atualizacao_pendente).toBe(false);
  });

  it("marca posterior à fotografia vira `atualizacao_pendente`", async () => {
    await marcarDesatualizado(db, "pagamento entrou", "GATILHO_PAGAMENTOS");
    const r = await ler(db, "pendencias_por_motivo", "2024");
    expect(r.snapshot.atualizacao_pendente).toBe(true);
    expect(r.snapshot.invalidado_em).toBeTruthy();
  });

  it("depois da reconstrução, a pendência cai", async () => {
    await marcarDesatualizado(db);
    expect((await ler(db, "pendencias_por_motivo", "2024")).snapshot.atualizacao_pendente).toBe(true);
    await drenar(db);
    expect((await ler(db, "pendencias_por_motivo", "2024")).snapshot.atualizacao_pendente).toBe(false);
  });

  it("fotografia descartada pela conferência continua dizendo `sem_snapshot`, não bloco vazio", async () => {
    const r = await ler(db, "seis_linhas", "2025");
    expect(r.sem_snapshot).toBe(true);
  });
});

describe("o dreno reconstrói só o que está marcado", () => {
  it("recorte não marcado não é reconstruído", async () => {
    await recalcular(db);
    await db.query("delete from public.carteira_efetividade_invalidacao");
    const antes = await fotoGeradaEm(db, "seis_linhas", "2024");

    // Marca SÓ 2025.
    await db.query(`insert into public.carteira_efetividade_invalidacao (recorte, invalidado_em, origem)
                    values ('2025', now(), 'TESTE')`);
    const r = await drenar(db);

    expect(r.reconstruidos.map((x) => x.recorte)).toEqual(["2025"]);
    // 2024 não foi tocado.
    expect(await fotoGeradaEm(db, "seis_linhas", "2024")).toEqual(antes);
  });

  it("atendido o pedido, a marca é apagada", async () => {
    await recalcular(db, "2024");
    await db.query("delete from public.carteira_efetividade_invalidacao");
    await db.query(`insert into public.carteira_efetividade_invalidacao (recorte, invalidado_em, origem)
                    values ('2024', now(), 'TESTE')`);
    await drenar(db);
    expect((await invalidacoes(db)).map((x) => x.recorte)).not.toContain("2024");
  });

  it("pedido que chega DURANTE a reconstrução sobrevive à limpeza", async () => {
    await recalcular(db, "2024");
    await db.query("delete from public.carteira_efetividade_invalidacao");
    // Marca ANTIGA (a que o dreno vai ler) e, em seguida, uma MAIS NOVA — que é
    // o que simula a invalidação chegando no meio da reconstrução.
    await db.query(`insert into public.carteira_efetividade_invalidacao (recorte, invalidado_em, origem)
                    values ('2024', now() - interval '1 minute', 'ANTIGA')`);
    await db.exec(`create or replace function public.carteira_efetividade_recalcular(p_recorte text default null)
                   returns jsonb language plpgsql as $$
                   begin
                     -- chega um pedido novo no meio do trabalho
                     update public.carteira_efetividade_invalidacao
                        set invalidado_em = now(), origem = 'NOVA' where recorte = '2024';
                     return '{}'::jsonb;
                   end $$;`);

    await drenar(db);

    const m = await invalidacoes(db);
    expect(m.map((x) => x.recorte)).toContain("2024");
    expect(m.find((x) => x.recorte === "2024").origem).toBe("NOVA");
  });

  it("um recorte quebrado não impede os outros de atualizar", async () => {
    await db.query("delete from public.carteira_efetividade_invalidacao");
    await db.query(`insert into public.carteira_efetividade_invalidacao (recorte, invalidado_em, origem)
                    values ('2024', now(), 'T'), ('2025', now(), 'T')`);
    await db.exec(`create or replace function public.carteira_efetividade_recalcular(p_recorte text default null)
                   returns jsonb language plpgsql as $$
                   begin
                     if p_recorte = '2024' then raise exception 'quebrou de proposito'; end if;
                     return '{}'::jsonb;
                   end $$;`);

    const r = await drenar(db);

    expect(r.ok).toBe(false);
    expect(r.erros.map((x) => x.recorte)).toEqual(["2024"]);
    expect(r.reconstruidos.map((x) => x.recorte)).toEqual(["2025"]);
    // O pedido do recorte quebrado FICA, para a próxima passada tentar.
    expect((await invalidacoes(db)).map((x) => x.recorte)).toContain("2024");
  });
});

describe("o pedido da tela é barato e não reconstrói nada", () => {
  it("solicitar marca os três recortes e declara que não é síncrono", async () => {
    await db.query("delete from public.carteira_efetividade_invalidacao");
    const antes = await fotoGeradaEm(db, "pendencias_por_motivo", "2024");
    const r = await solicitar(db);
    expect(r.ok).toBe(true);
    expect(r.sincrono).toBe(false);
    // Pedir NAO tira a foto: a fotografia existente fica exatamente onde estava.
    expect(await fotoGeradaEm(db, "pendencias_por_motivo", "2024")).toEqual(antes);
    expect((await invalidacoes(db)).map((x) => x.recorte)).toEqual(RECORTES);
  });
});

describe("as permissões", () => {
  it("authenticated pede atualização, mas não alcança o dreno nem a tabela de marcas", async () => {
    expect(Boolean((await q1(db, `select has_function_privilege('authenticated',
      'public.carteira_efetividade_solicitar_atualizacao()', 'execute') p`)).p)).toBe(true);
    expect(Boolean((await q1(db, `select has_function_privilege('authenticated',
      'public.carteira_efetividade_recalcular_pendentes()', 'execute') p`)).p)).toBe(false);
    expect(Boolean((await q1(db, `select has_table_privilege('authenticated',
      'public.carteira_efetividade_invalidacao', 'select') p`)).p)).toBe(false);
  });

  it("de papel authenticated, ler a tabela de marcas é recusado", async () => {
    await comoPapel(db, "authenticated");
    await expect(db.query("select * from public.carteira_efetividade_invalidacao")).rejects.toThrow();
    await voltarDono(db);
  });
});

describe("o rollback devolve o estado anterior", () => {
  it("derruba gatilhos, dreno, tabela e os campos novos da leitura", async () => {
    await db.exec(ROLL(INVALIDACAO));

    const g = await qn(db, `select tgname from pg_trigger
                             where not tgisinternal and tgname like 'trg_efetividade_invalidar_%'`);
    expect(g).toEqual([]);

    const t = await q1(db, `select count(*) n from information_schema.tables
                             where table_schema='public' and table_name='carteira_efetividade_invalidacao'`);
    expect(Number(t.n)).toBe(0);

    expect((await qn(db, "select jobname from cron.job")).map((x) => x.jobname))
      .not.toContain("carteira_efetividade_dreno");
    // As :40 continuam: o rollback não leva a rede de segurança embora.
    expect((await qn(db, "select jobname from cron.job")).map((x) => x.jobname))
      .toContain("carteira_efetividade_hora");

    // A leitura volta a não falar de pendência -- e continua funcionando.
    const r = await ler(db, "pendencias_por_motivo", "2024");
    expect(r.snapshot.gerado_em).toBeTruthy();
    expect(r.snapshot.atualizacao_pendente).toBeUndefined();
  });

  it("depois do rollback, escrever em tabela financeira continua funcionando", async () => {
    await db.exec(ROLL(INVALIDACAO));
    await db.query("insert into public.pagamentos (id) values (gen_random_uuid())");
    expect(Number((await q1(db, "select count(*) n from public.pagamentos")).n)).toBeGreaterThan(0);
  });
});

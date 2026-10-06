// A2c -- UMA curtida por operador por semana na Playlist ReATIVA.
//
// Roda a migration REAL (supabase/migrations/20261006183000_...) e o rollback
// REAL num PostgreSQL real (PGlite), em cima do estado real de producao:
// criacao das tabelas + A1 + A2 + as 3 musicas que existem hoje.
//
// As datas de teste ficam na semana de 05/10/2026 em diante -- a semana em que a
// regra entra em vigor. A semana de 28/09 e usada de proposito para provar o
// contrario: antes do corte, varias curtidas do mesmo operador continuam
// valendo, porque o historico nao foi reescrito.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import * as H from "./fixtures/portal_playlist/harness.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const [AMANDA_M, MAURICIO_M, FERNANDA_M] = H.REAIS.map((l) => l.id);

// Semana do corte: 05/10/2026 (segunda) a 11/10/2026 (domingo) em SP.
const SEMANA = "2026-10-05";
const SEG_0000 = "2026-10-05T03:00:00Z";   // segunda 00:00 em SP
const SEG_0900 = "2026-10-05T12:00:00Z";   // segunda 09:00 em SP
const QUA_1000 = "2026-10-07T13:00:00Z";   // quarta 10:00 em SP
const DOM_2359 = "2026-10-11T02:59:59Z";   // domingo 23:59:59 em SP

// Semana seguinte, para provar que a curtida volta a ficar livre na virada.
const SEMANA_2 = "2026-10-12";
const SEG_2 = "2026-10-12T03:00:00Z";

// Semana ANTERIOR ao corte: aqui a regra nao vale, por decisao da migration.
const SEMANA_ANTES = "2026-09-28";
const ANTES_1 = "2026-09-30T13:00:00Z";
const ANTES_2 = "2026-09-30T14:00:00Z";

const UNICIDADE = "23505";

let db;

beforeAll(async () => {
  db = await H.montarAntesDoA1();
  await H.aplicarA1(db);
  await H.aplicarA2(db);
  await H.aplicarA2c(db);
});
beforeEach(async () => { await H.resetar(db); });
afterAll(async () => { await db?.close(); });

const base = async () => { await H.resetar(db); return db; };

// Banco proprio, parado ANTES do A2c -- para os testes de backfill e rollback.
async function antesDoA2c() {
  const d = await H.montarAntesDoA1();
  await H.aplicarA1(d);
  await H.aplicarA2(d);
  return d;
}

describe("estrutura", () => {
  it("cria a coluna semana (not null), o gatilho e os tres indices de unicidade", async () => {
    const db = await base();

    expect(await H.q1(db, `select data_type, is_nullable from information_schema.columns
      where table_schema='public' and table_name='portal_curtidas' and column_name='semana'`))
      .toEqual({ data_type: "date", is_nullable: "NO" });

    expect(await H.qn(db, `select tgname from pg_trigger
      where tgrelid='public.portal_curtidas'::regclass and not tgisinternal order by tgname`))
      .toEqual([{ tgname: "portal_curtidas_semana_trg" }]);

    expect(await H.qn(db, `select indexname from pg_indexes
      where schemaname='public' and tablename='portal_curtidas' order by indexname`))
      .toEqual([
        { indexname: "portal_curtidas_pkey" },
        { indexname: "portal_curtidas_playlist_musica_semana_idx" },
        { indexname: "portal_curtidas_playlist_uma_por_semana_idx" },
        { indexname: "portal_curtidas_tipo_data_idx" },
        { indexname: "portal_curtidas_uma_por_pessoa_idx" },
      ]);
  });

  it("nao mexe em portal_playlist nem nas 3 musicas reais", async () => {
    const db = await base();
    const antes = await H.retrato(db);
    await H.aplicarA2c(db);
    expect(await H.retrato(db)).toEqual(antes);
    expect(antes.length).toBe(3);
  });

  it("aplicar duas vezes e inofensivo", async () => {
    const db = await base();
    await H.aplicarA2c(db);
    await H.aplicarA2c(db);
    expect((await H.curtir(db, H.LUANA, AMANDA_M, QUA_1000)).ok).toBe(true);
  });

  it("a semana sai de criado_em; o valor enviado pelo cliente e ignorado", async () => {
    const db = await base();

    const r = await H.comoUsuario(db, H.LUANA, async () => {
      try {
        await db.query(
          `insert into public.portal_curtidas (alvo_tipo, alvo_id, usuario_email, criado_em, semana)
           values ('playlist', $1, $2, $3, '1999-01-04')`,
          [AMANDA_M, H.LUANA, QUA_1000],
        );
        return { ok: true };
      } catch (e) { return { ok: false, code: e.code ?? null }; }
    });
    expect(r.ok).toBe(true);

    expect(await H.q1(db, `select semana::text from public.portal_curtidas`))
      .toEqual({ semana: SEMANA });
  });

  it("curtidas que ja existiam ganham a semana certa no backfill", async () => {
    const d = await antesDoA2c();
    await H.curtir(d, H.LUANA, AMANDA_M, ANTES_1);
    await H.curtir(d, H.LUANA, MAURICIO_M, ANTES_2);   // permitido antes do A2c
    await H.curtir(d, H.MAURICIO, FERNANDA_M, QUA_1000);

    await H.aplicarA2c(d);

    expect(await H.qn(d, `select semana::text, count(*)::int n from public.portal_curtidas
      group by 1 order by 1`))
      .toEqual([
        { semana: SEMANA_ANTES, n: 2 },
        { semana: SEMANA, n: 1 },
      ]);
    await d.close();
  });
});

describe("uma curtida por operador por semana", () => {
  it("a segunda curtida da semana, em OUTRA musica, e recusada", async () => {
    const db = await base();

    expect((await H.curtir(db, H.LUANA, AMANDA_M, SEG_0900)).ok).toBe(true);

    const r = await H.curtir(db, H.LUANA, MAURICIO_M, QUA_1000);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(UNICIDADE);

    expect(await H.q1(db, `select count(*)::int n from public.portal_curtidas`)).toEqual({ n: 1 });
  });

  it("a mesma musica duas vezes na mesma semana tambem e recusada", async () => {
    const db = await base();
    expect((await H.curtir(db, H.LUANA, AMANDA_M, SEG_0900)).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA, AMANDA_M, QUA_1000)).code).toBe(UNICIDADE);
  });

  it("e-mail com caixa diferente e o mesmo operador", async () => {
    const db = await base();
    expect((await H.curtir(db, H.LUANA, AMANDA_M, SEG_0900)).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA.toUpperCase(), MAURICIO_M, QUA_1000)).code).toBe(UNICIDADE);
  });

  it("a fronteira da semana inteira conta: segunda 00:00 e domingo 23:59:59 sao a mesma semana", async () => {
    const db = await base();
    expect((await H.curtir(db, H.LUANA, AMANDA_M, SEG_0000)).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA, MAURICIO_M, DOM_2359)).code).toBe(UNICIDADE);
  });

  it("operadores diferentes curtem na mesma semana, inclusive a mesma musica", async () => {
    const db = await base();
    expect((await H.curtir(db, H.LUANA, AMANDA_M, SEG_0900)).ok).toBe(true);
    expect((await H.curtir(db, H.MAURICIO, AMANDA_M, QUA_1000)).ok).toBe(true);
    expect((await H.curtir(db, H.FERNANDA, MAURICIO_M, QUA_1000)).ok).toBe(true);
    expect(await H.q1(db, `select count(*)::int n from public.portal_curtidas`)).toEqual({ n: 3 });
  });

  it("retirar a propria curtida libera outra musica na mesma semana", async () => {
    const db = await base();
    await H.curtir(db, H.LUANA, AMANDA_M, SEG_0900);
    expect((await H.curtir(db, H.LUANA, MAURICIO_M, QUA_1000)).code).toBe(UNICIDADE);

    expect((await H.descurtir(db, H.LUANA, AMANDA_M)).apagadas).toBe(1);
    expect((await H.curtir(db, H.LUANA, MAURICIO_M, QUA_1000)).ok).toBe(true);
  });

  it("na virada da semana a curtida fica livre de novo, sem descurtir nada", async () => {
    const db = await base();
    expect((await H.curtir(db, H.LUANA, AMANDA_M, DOM_2359)).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA, MAURICIO_M, SEG_2)).ok).toBe(true);

    expect(await H.qn(db, `select semana::text, count(*)::int n from public.portal_curtidas
      group by 1 order by 1`))
      .toEqual([{ semana: SEMANA, n: 1 }, { semana: SEMANA_2, n: 1 }]);
  });

  it("ninguem curte no nome de outra pessoa", async () => {
    const db = await base();
    const r = await H.comoUsuario(db, H.LUANA, async () => {
      try {
        await db.query(
          `insert into public.portal_curtidas (alvo_tipo, alvo_id, usuario_email, criado_em)
           values ('playlist', $1, $2, $3)`,
          [AMANDA_M, H.MAURICIO, QUA_1000],
        );
        return { ok: true };
      } catch (e) { return { ok: false, code: e.code ?? null }; }
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
  });
});

describe("o historico de antes do corte fica como aconteceu", () => {
  it("na semana de 28/09 o mesmo operador continua com varias curtidas", async () => {
    const db = await base();
    expect((await H.curtir(db, H.LUANA, AMANDA_M, ANTES_1)).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA, MAURICIO_M, ANTES_2)).ok).toBe(true);

    expect(await H.q1(db, `select count(*)::int n from public.portal_curtidas where semana = $1`, [SEMANA_ANTES]))
      .toEqual({ n: 2 });
  });

  it("mesmo antes do corte, a mesma musica duas vezes continua recusada", async () => {
    const db = await base();
    expect((await H.curtir(db, H.LUANA, AMANDA_M, ANTES_1)).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA, AMANDA_M, ANTES_2)).code).toBe(UNICIDADE);
  });

  it("curtida da semana anterior nao impede a curtida da semana do corte", async () => {
    const db = await base();
    expect((await H.curtir(db, H.LUANA, AMANDA_M, ANTES_1)).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA, AMANDA_M, QUA_1000)).ok).toBe(true);
  });
});

describe("elogio e ideia continuam com unicidade global por alvo", () => {
  // O CHECK de alvo_tipo e ampliado pelas migrations B e C1; aqui basta abrir
  // 'elogio' para exercitar o indice parcial que o A2c deixou para eles.
  const abrirElogio = (db) => db.exec(`
    alter table public.portal_curtidas drop constraint if exists portal_curtidas_alvo_tipo_check;
    alter table public.portal_curtidas add constraint portal_curtidas_alvo_tipo_check
      check (alvo_tipo in ('playlist','elogio'));`);

  const ELOGIO_A = "11111111-1111-4111-8111-111111111111";
  const ELOGIO_B = "22222222-2222-4222-8222-222222222222";

  it("a mesma pessoa curte dois elogios diferentes na mesma semana", async () => {
    const db = await base();
    await abrirElogio(db);
    expect((await H.curtir(db, H.LUANA, ELOGIO_A, QUA_1000, "elogio")).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA, ELOGIO_B, QUA_1000, "elogio")).ok).toBe(true);
  });

  it("o mesmo elogio duas vezes e recusado, inclusive em outra semana", async () => {
    const db = await base();
    await abrirElogio(db);
    expect((await H.curtir(db, H.LUANA, ELOGIO_A, QUA_1000, "elogio")).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA, ELOGIO_A, SEG_2, "elogio")).code).toBe(UNICIDADE);
  });

  it("curtida em elogio nao gasta a curtida da playlist", async () => {
    const db = await base();
    await abrirElogio(db);
    expect((await H.curtir(db, H.LUANA, ELOGIO_A, QUA_1000, "elogio")).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA, AMANDA_M, QUA_1000)).ok).toBe(true);
  });
});

describe("eu_curti passa a ser da semana consultada", () => {
  it("curti na semana passada: nesta semana eu_curti e falso em tudo", async () => {
    const db = await base();
    await H.curtir(db, H.LUANA, AMANDA_M, ANTES_1);

    expect(await H.curtidasDaSemana(db, H.LUANA, SEMANA)).toEqual([]);

    const anterior = await H.curtidasDaSemana(db, H.LUANA, SEMANA_ANTES);
    expect(anterior).toEqual([
      { alvo_id: AMANDA_M, curtidas_semana: 1, eu_curti: true },
    ]);
  });

  it("aponta em qual musica esta a minha curtida da semana", async () => {
    const db = await base();
    await H.curtir(db, H.LUANA, AMANDA_M, SEG_0900);
    await H.curtir(db, H.MAURICIO, MAURICIO_M, QUA_1000);

    const vistoPelaLuana = await H.curtidasDaSemana(db, H.LUANA, SEMANA);
    expect(vistoPelaLuana.find((l) => l.alvo_id === AMANDA_M).eu_curti).toBe(true);
    expect(vistoPelaLuana.find((l) => l.alvo_id === MAURICIO_M).eu_curti).toBe(false);

    const vistoPeloMauricio = await H.curtidasDaSemana(db, H.MAURICIO, SEMANA);
    expect(vistoPeloMauricio.find((l) => l.alvo_id === AMANDA_M).eu_curti).toBe(false);
    expect(vistoPeloMauricio.find((l) => l.alvo_id === MAURICIO_M).eu_curti).toBe(true);
  });

  it("a contagem da semana e a musica da semana continuam valendo", async () => {
    const db = await base();
    await H.curtir(db, H.LUANA, MAURICIO_M, SEG_0900);
    await H.curtir(db, H.AMANDA, MAURICIO_M, QUA_1000);
    await H.curtir(db, H.FERNANDA, AMANDA_M, QUA_1000);

    expect(await H.curtidasDaSemana(db, H.LUANA, SEMANA)).toEqual(
      [
        { alvo_id: AMANDA_M, curtidas_semana: 1, eu_curti: false },
        { alvo_id: MAURICIO_M, curtidas_semana: 2, eu_curti: true },
      ].sort((a, b) => (a.alvo_id < b.alvo_id ? -1 : 1)),
    );

    const vencedora = await H.musicaDaSemana(db, H.LUANA, SEMANA);
    expect(vencedora.id).toBe(MAURICIO_M);
    expect(vencedora.curtidas).toBe(2);
  });
});

describe("rollback", () => {
  it("desfaz coluna, gatilho e indices, e nao apaga nenhuma curtida", async () => {
    const d = await antesDoA2c();
    await H.aplicarA2c(d);
    await H.curtir(d, H.LUANA, AMANDA_M, SEG_0900);
    await H.curtir(d, H.MAURICIO, MAURICIO_M, QUA_1000);

    await d.exec(H.ROLL(H.A2C));

    expect(await H.q1(d, `select count(*)::int n from public.portal_curtidas`)).toEqual({ n: 2 });
    expect(await H.qn(d, `select column_name from information_schema.columns
      where table_schema='public' and table_name='portal_curtidas' and column_name='semana'`)).toEqual([]);
    expect(await H.qn(d, `select tgname from pg_trigger
      where tgrelid='public.portal_curtidas'::regclass and not tgisinternal`)).toEqual([]);
    expect(await H.qn(d, `select indexname from pg_indexes
      where schemaname='public' and tablename='portal_curtidas' order by indexname`))
      .toEqual([
        { indexname: "portal_curtidas_pkey" },
        { indexname: "portal_curtidas_tipo_data_idx" },
        { indexname: "portal_curtidas_uma_por_pessoa_idx" },
      ]);
    await d.close();
  });

  it("depois do rollback, a regra antiga volta: varias musicas por semana", async () => {
    const d = await antesDoA2c();
    await H.aplicarA2c(d);
    await d.exec(H.ROLL(H.A2C));

    expect((await H.curtir(d, H.LUANA, AMANDA_M, SEG_0900)).ok).toBe(true);
    expect((await H.curtir(d, H.LUANA, MAURICIO_M, QUA_1000)).ok).toBe(true);
    expect((await H.curtir(d, H.LUANA, AMANDA_M, SEG_2)).code).toBe(UNICIDADE);
    await d.close();
  });
});

// A2 -- curtidas do Portal e musica mais curtida da semana.
//
// Roda a migration REAL (supabase/migrations/20260930164843_...) e o
// rollback REAL num PostgreSQL real (PGlite), em cima do estado real de
// producao: criacao das tabelas + A1 + as 3 musicas que existem hoje.
//
// As 3 musicas sao REAIS; as curtidas sao de teste, com horarios escolhidos para
// exercitar a fronteira da semana em America/Sao_Paulo.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import * as H from "./fixtures/portal_playlist/harness.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const [AMANDA_M, MAURICIO_M, FERNANDA_M] = H.REAIS.map((l) => l.id);

// Semana de 28/09/2026 (segunda) a 04/10/2026 (domingo), em America/Sao_Paulo.
const SEMANA = "2026-09-28";
const SEG_0000 = "2026-09-28T03:00:00Z";        // segunda 00:00 em SP
const QUA_1000 = "2026-09-30T13:00:00Z";        // quarta 10:00 em SP
const DOM_2359 = "2026-10-04T02:59:59Z";        // domingo 23:59:59 em SP
const DOM_2130 = "2026-10-05T00:30:00Z";        // domingo 21:30 em SP (ja e segunda em UTC)
const SEG_SEG  = "2026-10-05T03:00:00Z";        // segunda seguinte 00:00 em SP
const ANTERIOR = "2026-09-27T12:00:00Z";        // semana anterior

// UM banco para o arquivo inteiro, com H.resetar() barato entre os testes (que
// tambem limpa portal_curtidas). Instanciar um PGlite por teste seria ~3x mais
// lento e a suite completa roda no CI com timeout de 15 minutos. Os testes que
// precisam de outro estado -- antes do A2, ou depois do rollback -- abrem o seu.
let db;

beforeAll(async () => {
  db = await H.montarAntesDoA1();
  await H.aplicarA1(db);
  await H.aplicarA2(db);
});
beforeEach(async () => { await H.resetar(db); });
afterAll(async () => { await db?.close(); });

const base = async () => { await H.resetar(db); return db; };

describe("estrutura", () => {
  it("cria a tabela, o unique por pessoa, o indice de data e 3 policies", async () => {
    const db = await base();

    expect(await H.qn(db, `select relrowsecurity from pg_class where oid='public.portal_curtidas'::regclass`))
      .toEqual([{ relrowsecurity: true }]);

    expect(await H.qn(db, `select indexname from pg_indexes
      where schemaname='public' and tablename='portal_curtidas' order by indexname`))
      .toEqual([
        { indexname: "portal_curtidas_pkey" },
        { indexname: "portal_curtidas_tipo_data_idx" },
        { indexname: "portal_curtidas_uma_por_pessoa_idx" },
      ]);

    expect(await H.qn(db, `select policyname, cmd from pg_policies
      where schemaname='public' and tablename='portal_curtidas' order by policyname`))
      .toEqual([
        { policyname: "portal_curtidas_inserir_propria", cmd: "INSERT" },
        { policyname: "portal_curtidas_leitura", cmd: "SELECT" },
        { policyname: "portal_curtidas_remover_propria", cmd: "DELETE" },
      ]);

    // Nenhuma coluna de contador: a contagem e sempre derivada de criado_em.
    expect(await H.qn(db, `select column_name from information_schema.columns
      where table_schema='public' and table_name='portal_curtidas' order by ordinal_position`))
      .toEqual([
        { column_name: "id" }, { column_name: "alvo_tipo" }, { column_name: "alvo_id" },
        { column_name: "usuario_email" }, { column_name: "criado_em" },
      ]);

  });

  it("nao mexe em portal_playlist nem nas 3 musicas reais", async () => {
    const db = await H.montarAntesDoA1();
    await H.aplicarA1(db);
    const antes = await H.retrato(db);
    await H.aplicarA2(db);

    expect(await H.retrato(db)).toEqual(antes);
    expect(await H.qn(db, `select policyname from pg_policies
      where schemaname='public' and tablename='portal_playlist' order by policyname`))
      .toEqual([
        { policyname: "portal_playlist_inserir_propria" },
        { policyname: "portal_playlist_leitura" },
        { policyname: "portal_playlist_remover" },
      ]);
    await db.close();
  });

  it("aplicar duas vezes e inofensivo", async () => {
    const db = await base();
    await H.curtir(db, H.LUANA, AMANDA_M);
    await H.aplicarA2(db);
    expect(Number((await H.q1(db, "select count(*) n from public.portal_curtidas")).n)).toBe(1);
  });
});

describe("uma curtida por pessoa, garantida pelo banco", () => {
  it("a segunda curtida da mesma pessoa na mesma musica e recusada", async () => {
    const db = await base();

    const a = await H.curtir(db, H.LUANA, AMANDA_M);
    const b = await H.curtir(db, H.LUANA, AMANDA_M);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.code).toBe("23505"); // unique_violation -- constraint, nao gatilho
    expect(Number((await H.q1(db, "select count(*) n from public.portal_curtidas")).n)).toBe(1);

  });

  it("e-mail com caixa diferente e a mesma pessoa", async () => {
    const db = await base();
    expect((await H.curtir(db, H.LUANA, AMANDA_M)).ok).toBe(true);
    const r = await H.curtir(db, H.LUANA.toUpperCase(), AMANDA_M);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("23505");
  });

  it("pessoas diferentes curtem a mesma musica; a mesma pessoa curte musicas diferentes", async () => {
    const db = await base();
    for (const e of [H.LUANA, H.MAURICIO, H.FERNANDA]) expect((await H.curtir(db, e, AMANDA_M)).ok).toBe(true);
    for (const m of [MAURICIO_M, FERNANDA_M]) expect((await H.curtir(db, H.LUANA, m)).ok).toBe(true);
    expect(Number((await H.q1(db, "select count(*) n from public.portal_curtidas")).n)).toBe(5);
  });

  it("ninguem curte no nome de outra pessoa", async () => {
    const db = await base();
    const r = await H.comoUsuario(db, H.LUANA, async () => {
      try {
        await db.query(`insert into public.portal_curtidas (alvo_tipo, alvo_id, usuario_email)
                        values ('playlist', $1, $2)`, [AMANDA_M, H.MAURICIO]);
        return { ok: true };
      } catch (e) { return { ok: false, code: e.code }; }
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501"); // RLS
  });

  it("alvo_tipo so aceita 'playlist' nesta etapa", async () => {
    const db = await base();
    const r = await H.curtir(db, H.LUANA, AMANDA_M, null, "elogio");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("23514"); // check_violation
  });
});

describe("retirar a propria curtida", () => {
  it("descurtir apaga a linha e libera nova curtida com data NOVA", async () => {
    const db = await base();

    await H.curtir(db, H.LUANA, AMANDA_M, ANTERIOR);
    const antes = await H.q1(db, "select criado_em from public.portal_curtidas");

    const del = await H.descurtir(db, H.LUANA, AMANDA_M);
    expect(del.ok).toBe(true);
    expect(Number((await H.q1(db, "select count(*) n from public.portal_curtidas")).n)).toBe(0);

    // Recurtir cria linha NOVA -- e por isso que descurtir e DELETE e nao ativo=false:
    // a data precisa ser a da nova curtida, senao a contagem semanal sai errada.
    expect((await H.curtir(db, H.LUANA, AMANDA_M, QUA_1000)).ok).toBe(true);
    const depois = await H.q1(db, "select criado_em from public.portal_curtidas");
    expect(new Date(depois.criado_em).getTime()).toBeGreaterThan(new Date(antes.criado_em).getTime());

  });

  it("ninguem retira a curtida de outra pessoa", async () => {
    const db = await base();
    await H.curtir(db, H.MAURICIO, AMANDA_M);

    const r = await H.descurtir(db, H.LUANA, AMANDA_M);
    expect(r.ok).toBe(true);
    expect(Number((await H.q1(db, "select count(*) n from public.portal_curtidas")).n)).toBe(1);
    expect((await H.q1(db, "select usuario_email e from public.portal_curtidas")).e).toBe(H.MAURICIO);

  });
});

describe("janela da semana em America/Sao_Paulo", () => {
  it("segunda 00:00 e domingo 23:59:59 entram; a semana anterior e a seguinte ficam de fora", async () => {
    const db = await base();

    await H.curtir(db, H.LUANA,    AMANDA_M, SEG_0000);
    await H.curtir(db, H.MAURICIO, AMANDA_M, DOM_2359);
    await H.curtir(db, H.FERNANDA, AMANDA_M, ANTERIOR);
    await H.curtir(db, H.AMANDA,   AMANDA_M, SEG_SEG);

    const r = await H.curtidasDaSemana(db, H.LUANA, SEMANA);
    expect(r).toEqual([{ alvo_id: AMANDA_M, curtidas_semana: 2, eu_curti: true }]);

    // Nenhuma curtida foi apagada: as 4 continuam na tabela.
    expect(Number((await H.q1(db, "select count(*) n from public.portal_curtidas")).n)).toBe(4);
  });

  it("domingo 21:30 em SP ainda e desta semana, embora ja seja segunda em UTC", async () => {
    const db = await base();
    await H.curtir(db, H.LUANA, AMANDA_M, DOM_2130);

    expect(await H.curtidasDaSemana(db, H.LUANA, SEMANA))
      .toEqual([{ alvo_id: AMANDA_M, curtidas_semana: 1, eu_curti: true }]);

    // Se a janela fosse em UTC, esta curtida cairia na semana seguinte.
    expect((await H.q1(db, `select public.portal_semana_sp($1::timestamptz)::text s`, [DOM_2130])).s)
      .toBe(SEMANA);
    expect((await H.q1(db, `select (date_trunc('week', ($1::timestamptz at time zone 'UTC')))::date::text s`, [DOM_2130])).s)
      .toBe("2026-10-05");
  });

  it("semana anterior continua consultavel -- o historico nao some", async () => {
    const db = await base();
    await H.curtir(db, H.LUANA, AMANDA_M, ANTERIOR);
    await H.curtir(db, H.MAURICIO, MAURICIO_M, QUA_1000);

    expect(await H.curtidasDaSemana(db, H.LUANA, "2026-09-21"))
      .toEqual([{ alvo_id: AMANDA_M, curtidas_semana: 1, eu_curti: true }]);
    expect(await H.musicaDaSemana(db, H.LUANA, "2026-09-21"))
      .toMatchObject({ id: AMANDA_M, curtidas: 1, semana: expect.anything() });
  });

  it("eu_curti olha todas as semanas, porque a unicidade e global", async () => {
    const db = await base();
    await H.curtir(db, H.LUANA, AMANDA_M, ANTERIOR); // curti semana passada

    // Nesta semana a musica tem 0 curtidas, mas eu ja curti e nao posso de novo.
    expect(await H.curtidasDaSemana(db, H.LUANA, SEMANA))
      .toEqual([{ alvo_id: AMANDA_M, curtidas_semana: 0, eu_curti: true }]);
    expect((await H.curtir(db, H.LUANA, AMANDA_M, QUA_1000)).code).toBe("23505");
  });
});

describe("musica mais curtida da semana", () => {
  it("vence quem tem mais curtidas na semana", async () => {
    const db = await base();
    await H.curtir(db, H.LUANA,    MAURICIO_M, QUA_1000);
    await H.curtir(db, H.FERNANDA, MAURICIO_M, QUA_1000);
    await H.curtir(db, H.AMANDA,   AMANDA_M,   QUA_1000);

    expect(await H.musicaDaSemana(db, H.LUANA, SEMANA)).toMatchObject({
      id: MAURICIO_M, titulo: "Vou pra Santa Catarina", artista: "Terceira Dimensão",
      adicionado_por: "Mauricio", curtidas: 2, semana: expect.anything(),
    });
  });

  it("empate no total -> vence a curtida mais antiga DA SEMANA", async () => {
    const db = await base();
    await H.curtir(db, H.LUANA,    FERNANDA_M, "2026-09-29T12:00:00Z"); // terca
    await H.curtir(db, H.MAURICIO, AMANDA_M,   "2026-09-30T12:00:00Z"); // quarta

    expect((await H.musicaDaSemana(db, H.LUANA, SEMANA)).id).toBe(FERNANDA_M);
  });

  it("empate no total e no horario -> vence a musica cadastrada primeiro", async () => {
    const db = await base();
    // Bellyache (13:10) e mais antiga que Oceans (13:29).
    await H.curtir(db, H.LUANA,    FERNANDA_M, QUA_1000);
    await H.curtir(db, H.MAURICIO, AMANDA_M,   QUA_1000);

    expect((await H.musicaDaSemana(db, H.LUANA, SEMANA)).id).toBe(AMANDA_M);
  });

  it("musica removida da playlist mantem as curtidas mas sai da disputa", async () => {
    const db = await base();
    await H.curtir(db, H.LUANA,    MAURICIO_M, QUA_1000);
    await H.curtir(db, H.FERNANDA, MAURICIO_M, QUA_1000);
    await H.curtir(db, H.AMANDA,   AMANDA_M,   QUA_1000);
    expect((await H.musicaDaSemana(db, H.LUANA, SEMANA)).id).toBe(MAURICIO_M);

    await H.atualizar(db, H.MAURICIO, MAURICIO_M, "ativo = false", []);

    // Passa a vencer a segunda colocada...
    expect((await H.musicaDaSemana(db, H.LUANA, SEMANA)).id).toBe(AMANDA_M);
    // ...e as curtidas da removida continuam gravadas.
    expect(Number((await H.q1(db,
      "select count(*) n from public.portal_curtidas where alvo_id=$1", [MAURICIO_M])).n)).toBe(2);
  });

  it("sem curtidas na semana, nao ha vencedora", async () => {
    const db = await base();
    expect(await H.musicaDaSemana(db, H.LUANA, SEMANA)).toBeNull();

    // Curtida fora da semana tambem nao elege ninguem nesta semana.
    await H.curtir(db, H.LUANA, AMANDA_M, ANTERIOR);
    expect(await H.musicaDaSemana(db, H.LUANA, SEMANA)).toBeNull();
  });

  it("descurtir muda o resultado na hora", async () => {
    const db = await base();
    await H.curtir(db, H.LUANA,    MAURICIO_M, QUA_1000);
    await H.curtir(db, H.FERNANDA, MAURICIO_M, QUA_1000);
    await H.curtir(db, H.AMANDA,   AMANDA_M,   "2026-09-29T12:00:00Z");
    expect((await H.musicaDaSemana(db, H.LUANA, SEMANA)).id).toBe(MAURICIO_M);

    await H.descurtir(db, H.FERNANDA, MAURICIO_M);
    // 1 x 1 -> desempata pela curtida mais antiga da semana (terca, da Amanda).
    expect((await H.musicaDaSemana(db, H.LUANA, SEMANA)).id).toBe(AMANDA_M);
  });

  it("sem p_semana, usa a semana corrente", async () => {
    const db = await base();
    await H.curtir(db, H.LUANA, FERNANDA_M); // criado_em = now()
    expect((await H.musicaDaSemana(db, H.LUANA)).id).toBe(FERNANDA_M);
  });
});

describe("rollback", () => {
  // Estes testes DERRUBAM portal_curtidas, entao nao podem usar o banco
  // compartilhado do arquivo: cada um monta e fecha o seu.
  const proprio = async () => {
    const d = await H.montarAntesDoA1();
    await H.aplicarA1(d);
    await H.aplicarA2(d);
    return d;
  };

  it("sem curtidas, desfaz tudo e a playlist fica intacta", async () => {
    const db = await proprio();
    const antes = await H.retrato(db);

    await db.exec(H.ROLL(H.A2));

    expect(await H.qn(db, `select to_regclass('public.portal_curtidas')::text t`)).toEqual([{ t: null }]);
    expect(await H.qn(db, `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and proname in
      ('portal_semana_sp','portal_curtidas_da_semana','portal_musica_da_semana')`)).toEqual([]);
    expect(await H.retrato(db)).toEqual(antes);
    // O A1 continua de pe.
    expect(await H.qn(db, `select tgname from pg_trigger
      where tgrelid='public.portal_playlist'::regclass and not tgisinternal`))
      .toEqual([{ tgname: "portal_playlist_limite_tres_trg" }]);
    await db.close();
  });

  it("com curtidas, recusa apagar sem confirmacao explicita", async () => {
    const db = await proprio();
    await H.curtir(db, H.LUANA, AMANDA_M);

    let erro = null;
    try { await db.exec(H.ROLL(H.A2)); } catch (e) { erro = e; }

    expect(erro).not.toBeNull();
    expect(erro.code).toBe("PL005");
    // Nada foi desfeito.
    expect(Number((await H.q1(db, "select count(*) n from public.portal_curtidas")).n)).toBe(1);
    await db.close();
  });

  it("com confirmacao explicita da gestao, desfaz", async () => {
    const db = await proprio();
    await H.curtir(db, H.LUANA, AMANDA_M);

    await db.query("select set_config('portal.rollback_curtidas_confirmado','sim',false)");
    await db.exec(H.ROLL(H.A2));

    expect(await H.qn(db, `select to_regclass('public.portal_curtidas')::text t`)).toEqual([{ t: null }]);
    await db.close();
  });
});

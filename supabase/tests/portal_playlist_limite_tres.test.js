// A1 -- Playlist ReATIVA: ate 3 musicas ativas por pessoa.
//
// Roda a migration REAL (supabase/aguardando_aprovacao/20260930153000...) e o
// rollback REAL num PostgreSQL real (PGlite), em cima do estado real de
// producao: a migration de criacao 20260929152500 mais as 3 linhas que existem
// hoje em public.portal_playlist.
//
// As 3 linhas sao dados REAIS (equipe interna). As musicas de teste sao
// ficticias e sempre de pessoas que nao tem musica real, para nao confundir
// evidencia com invencao.
import { describe, it, expect, beforeAll } from "vitest";
import * as H from "./fixtures/portal_playlist/harness.js";

let db;

async function base() {
  const d = await H.montarAntesDoA1();
  await H.aplicarA1(d);
  return d;
}

describe("estado ANTES do A1 (producao de hoje)", () => {
  it("tem as 3 musicas reais, o unique semanal e nenhum gatilho de limite", async () => {
    const d = await H.montarAntesDoA1();

    expect(await H.retrato(d)).toEqual(H.REAIS.map((l) => ({
      id: l.id, titulo: l.titulo, artista: l.artista, youtube_id: l.youtube_id,
      adicionado_por: l.adicionado_por, adicionado_por_email: l.adicionado_por_email,
      semana_chave: l.semana_chave, ativo: true,
      criado_em: expect.any(String),
    })));

    expect(await H.qn(d, `select conname from pg_constraint
      where conrelid = 'public.portal_playlist'::regclass and contype = 'u' order by conname`))
      .toEqual([
        { conname: "portal_playlist_adicionado_por_email_semana_chave_key" },
      ]);

    expect(await H.qn(d, `select tgname from pg_trigger
      where tgrelid = 'public.portal_playlist'::regclass and not tgisinternal`)).toEqual([]);

    // O limite de hoje: a MESMA pessoa nao consegue a 2a musica na mesma semana.
    const segunda = await H.inserir(d, H.LUANA, "Primeira da Luana");
    expect(segunda.ok).toBe(true);
    const terceira = await H.inserir(d, H.LUANA, "Segunda da Luana");
    expect(terceira.ok).toBe(false);
    expect(terceira.code).toBe("23505"); // unique_violation

    await d.close();
  });
});

describe("a migration nao perde nem altera as 3 musicas reais", () => {
  it("as 3 linhas ficam byte a byte iguais depois de aplicar o A1", async () => {
    const d = await H.montarAntesDoA1();
    const antes = await H.retrato(d);
    await H.aplicarA1(d);
    const depois = await H.retrato(d);

    expect(depois).toEqual(antes);
    expect(depois).toHaveLength(3);
    expect(depois.map((l) => l.titulo)).toEqual(["Bellyache", "Vou pra Santa Catarina", "Oceans"]);

    await d.close();
  });

  it("aplicar duas vezes e inofensivo (idempotente) e nao duplica gatilho", async () => {
    const d = await base();
    const antes = await H.retrato(d);
    await H.aplicarA1(d);
    expect(await H.retrato(d)).toEqual(antes);
    expect((await H.qn(d, `select tgname from pg_trigger
      where tgrelid = 'public.portal_playlist'::regclass and not tgisinternal`))).toHaveLength(1);
    await d.close();
  });
});

describe("estrutura depois do A1", () => {
  beforeAll(async () => { db = await base(); });

  it("o unique semanal saiu e o gatilho do limite entrou", async () => {
    expect(await H.qn(db, `select conname from pg_constraint
      where conrelid = 'public.portal_playlist'::regclass and contype = 'u'`)).toEqual([]);

    expect(await H.qn(db, `select tgname from pg_trigger
      where tgrelid = 'public.portal_playlist'::regclass and not tgisinternal`))
      .toEqual([{ tgname: "portal_playlist_limite_tres_trg" }]);
  });

  it("a funcao do limite e SECURITY DEFINER com search_path fixo", async () => {
    const f = await H.q1(db, `select p.prosecdef, p.proconfig::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'portal_playlist_limite_tres'`);
    expect(f.prosecdef).toBe(true);
    expect(f.proconfig).toContain("search_path=public, pg_temp");
  });

  it("nenhuma policy foi criada, alterada ou removida pelo A1", async () => {
    expect(await H.qn(db, `select policyname, cmd from pg_policies
      where schemaname = 'public' and tablename = 'portal_playlist' order by policyname`))
      .toEqual([
        { policyname: "portal_playlist_inserir_propria", cmd: "INSERT" },
        { policyname: "portal_playlist_leitura", cmd: "SELECT" },
        { policyname: "portal_playlist_remover", cmd: "UPDATE" },
      ]);
  });

  it("nada fora de portal_playlist foi tocado", async () => {
    // portal_eventos e portal_aniversarios seguem com a mesma estrutura.
    expect(await H.qn(db, `select tgname from pg_trigger
      where tgrelid in ('public.portal_eventos'::regclass, 'public.portal_aniversarios'::regclass)
        and not tgisinternal`)).toEqual([]);
    expect(await H.qn(db, `select count(*)::int n from pg_policies
      where schemaname='public' and tablename in ('portal_eventos','portal_aniversarios')`))
      .toEqual([{ n: 4 }]);
  });
});

describe("semana_chave passa a ser America/Sao_Paulo (item 10)", () => {
  it("o default guardado cita America/Sao_Paulo", async () => {
    const d = await base();
    const def = await H.q1(d, `select column_default from information_schema.columns
      where table_schema='public' and table_name='portal_playlist' and column_name='semana_chave'`);
    expect(def.column_default).toContain("America/Sao_Paulo");
    await d.close();
  });

  it("o fuso muda a semana no domingo a noite -- era isso que estava errado", async () => {
    const d = await base();
    // Domingo 04/10/2026, 21:30 em Sao Paulo, que ja e segunda 00:30 em UTC.
    const r = await H.q1(d, `
      select (date_trunc('week', (timestamptz '2026-10-04 21:30:00-03' at time zone 'America/Sao_Paulo')))::date::text as sao_paulo,
             (date_trunc('week', (timestamptz '2026-10-04 21:30:00-03' at time zone 'UTC')))::date::text        as utc`);
    expect(r.sao_paulo).toBe("2026-09-28"); // domingo ainda pertence a semana que comecou em 28/09
    expect(r.utc).toBe("2026-10-05");       // UTC ja jogou para a semana seguinte
    expect(r.sao_paulo).not.toBe(r.utc);
    await d.close();
  });

  it("linha nova cai numa segunda-feira", async () => {
    const d = await base();
    const r = await H.inserir(d, H.LUANA, "Semana da Luana");
    expect(r.ok).toBe(true);
    const l = await H.q1(d, `select semana_chave::text s, extract(isodow from semana_chave)::int dow
      from public.portal_playlist where id = $1`, [r.id]);
    expect(l.dow).toBe(1); // 1 = segunda
    expect(l.s).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await d.close();
  });
});

describe("limite de 3: 1a, 2a, 3a passam e a 4a e barrada", () => {
  it("pessoa sem musica: 1a OK, 2a OK, 3a OK, 4a recusada com PL003", async () => {
    const d = await base();
    const evid = [];

    for (const [n, titulo] of [[1, "Musica 1"], [2, "Musica 2"], [3, "Musica 3"], [4, "Musica 4"]]) {
      const r = await H.inserir(d, H.LUANA, titulo);
      evid.push({ tentativa: n, aceita: r.ok, code: r.code, ativas: await H.ativasDe(d, H.LUANA) });
    }

    expect(evid).toEqual([
      { tentativa: 1, aceita: true,  code: undefined, ativas: 1 },
      { tentativa: 2, aceita: true,  code: undefined, ativas: 2 },
      { tentativa: 3, aceita: true,  code: undefined, ativas: 3 },
      { tentativa: 4, aceita: false, code: "PL003",   ativas: 3 },
    ]);

    console.log("EVIDENCIA 1a/2a/3a/4a:", JSON.stringify(evid));
    await d.close();
  });

  it("conta a musica real que a pessoa ja tem: Amanda chega a 3 e para", async () => {
    const d = await base();
    expect(await H.ativasDe(d, H.AMANDA)).toBe(1); // "Bellyache", real

    expect((await H.inserir(d, H.AMANDA, "Segunda da Amanda")).ok).toBe(true);
    expect((await H.inserir(d, H.AMANDA, "Terceira da Amanda")).ok).toBe(true);
    const quarta = await H.inserir(d, H.AMANDA, "Quarta da Amanda");

    expect(quarta.ok).toBe(false);
    expect(quarta.code).toBe("PL003");
    expect(await H.ativasDe(d, H.AMANDA)).toBe(3);

    // A musica real continua la, intacta.
    expect(await H.q1(d, `select titulo from public.portal_playlist where id = $1`, [H.REAIS[0].id]))
      .toEqual({ titulo: "Bellyache" });
    await d.close();
  });

  it("o limite e por pessoa: uma no limite nao impede as outras", async () => {
    const d = await base();
    for (const t of ["L1", "L2", "L3"]) expect((await H.inserir(d, H.LUANA, t)).ok).toBe(true);
    expect((await H.inserir(d, H.LUANA, "L4")).ok).toBe(false);

    // Mauricio tem 1 real; segue podendo incluir.
    expect((await H.inserir(d, H.MAURICIO, "M2")).ok).toBe(true);
    expect(await H.ativasDe(d, H.MAURICIO)).toBe(2);
    await d.close();
  });

  it("duas musicas na MESMA semana agora sao permitidas (limite semanal removido)", async () => {
    const d = await base();
    const a = await H.inserir(d, H.LUANA, "Mesma semana 1");
    const b = await H.inserir(d, H.LUANA, "Mesma semana 2");
    expect([a.ok, b.ok]).toEqual([true, true]);

    const semanas = await H.qn(d, `select distinct semana_chave::text s from public.portal_playlist
      where adicionado_por_email = $1`, [H.LUANA]);
    expect(semanas).toHaveLength(1); // as duas na mesma semana
    await d.close();
  });
});

describe("editar nao consome vaga", () => {
  it("com 3 ativas, editar titulo/artista/link funciona e continua 3", async () => {
    const d = await base();
    const ids = [];
    for (const t of ["E1", "E2", "E3"]) ids.push((await H.inserir(d, H.LUANA, t)).id);
    expect(await H.ativasDe(d, H.LUANA)).toBe(3);
    expect((await H.inserir(d, H.LUANA, "E4")).code).toBe("PL003"); // esta no limite

    const r = await H.atualizar(d, H.LUANA, ids[0],
      "titulo = $2, artista = $3, youtube_id = $4", ["E1 editada", "Outro Artista", "bbbbbbbbbbb"]);

    expect(r.ok).toBe(true);
    expect(await H.ativasDe(d, H.LUANA)).toBe(3); // nao virou 4
    expect(await H.q1(d, `select titulo, artista, youtube_id from public.portal_playlist where id = $1`, [ids[0]]))
      .toEqual({ titulo: "E1 editada", artista: "Outro Artista", youtube_id: "bbbbbbbbbbb" });

    console.log("EVIDENCIA editar: ativas antes=3 depois=" + (await H.ativasDe(d, H.LUANA)));
    await d.close();
  });

  it("editar uma das 3 musicas reais tambem nao consome vaga", async () => {
    const d = await base();
    const r = await H.atualizar(d, H.FERNANDA, H.REAIS[2].id, "titulo = $2", ["Oceans (ao vivo)"]);
    expect(r.ok).toBe(true);
    expect(await H.ativasDe(d, H.FERNANDA)).toBe(1);
    await d.close();
  });
});

describe("remover com soft delete libera a vaga imediatamente", () => {
  it("ativo = false baixa a contagem e a vaga volta na hora", async () => {
    const d = await base();
    const ids = [];
    for (const t of ["R1", "R2", "R3"]) ids.push((await H.inserir(d, H.LUANA, t)).id);

    const passos = [];
    passos.push({ passo: "3 cadastradas", ativas: await H.ativasDe(d, H.LUANA), quarta: (await H.inserir(d, H.LUANA, "R4a")).code });

    const del = await H.atualizar(d, H.LUANA, ids[1], "ativo = false", []);
    expect(del.ok).toBe(true);
    passos.push({ passo: "apos remover R2", ativas: await H.ativasDe(d, H.LUANA) });

    const nova = await H.inserir(d, H.LUANA, "R4b");
    passos.push({ passo: "nova musica na vaga liberada", aceita: nova.ok, ativas: await H.ativasDe(d, H.LUANA) });

    expect(passos).toEqual([
      { passo: "3 cadastradas", ativas: 3, quarta: "PL003" },
      { passo: "apos remover R2", ativas: 2 },
      { passo: "nova musica na vaga liberada", aceita: true, ativas: 3 },
    ]);

    // Soft delete: a linha removida CONTINUA na tabela, so inativa.
    expect(await H.q1(d, `select titulo, ativo from public.portal_playlist where id = $1`, [ids[1]]))
      .toEqual({ titulo: "R2", ativo: false });
    expect(Number((await H.q1(d, `select count(*) n from public.portal_playlist where adicionado_por_email = $1`, [H.LUANA])).n)).toBe(4);

    console.log("EVIDENCIA remover/liberar:", JSON.stringify(passos));
    await d.close();
  });

  it("reativar uma musica removida NAO fura o limite", async () => {
    const d = await base();
    const ids = [];
    for (const t of ["X1", "X2", "X3"]) ids.push((await H.inserir(d, H.LUANA, t)).id);
    await H.atualizar(d, H.LUANA, ids[0], "ativo = false", []);      // sobra 2
    expect((await H.inserir(d, H.LUANA, "X4")).ok).toBe(true);        // volta a 3

    const revive = await H.atualizar(d, H.LUANA, ids[0], "ativo = true", []);
    expect(revive.ok).toBe(false);
    expect(revive.code).toBe("PL003");
    expect(await H.ativasDe(d, H.LUANA)).toBe(3);
    await d.close();
  });

  it("reativar quando ha vaga funciona", async () => {
    const d = await base();
    const id = (await H.inserir(d, H.LUANA, "Y1")).id;
    await H.atualizar(d, H.LUANA, id, "ativo = false", []);
    expect(await H.ativasDe(d, H.LUANA)).toBe(0);
    expect((await H.atualizar(d, H.LUANA, id, "ativo = true", [])).ok).toBe(true);
    expect(await H.ativasDe(d, H.LUANA)).toBe(1);
    await d.close();
  });
});

describe("concorrencia: o advisory lock por pessoa", () => {
  it("o gatilho realmente toma um advisory lock, e um por pessoa", async () => {
    const d = await base();

    await d.exec("begin");
    await d.query(
      `insert into public.portal_playlist (titulo, artista, youtube_id, adicionado_por, adicionado_por_email)
       values ('Lock 1','A','aaaaaaaaaaa','Luana',$1)`, [H.LUANA]);
    const umaPessoa = await H.qn(d, `select classid, objid from pg_locks where locktype = 'advisory'`);

    await d.query(
      `insert into public.portal_playlist (titulo, artista, youtube_id, adicionado_por, adicionado_por_email)
       values ('Lock 2','A','aaaaaaaaaaa','Mauricio',$1)`, [H.MAURICIO]);
    const duasPessoas = await H.qn(d, `select classid, objid from pg_locks where locktype = 'advisory'`);
    await d.exec("rollback");

    // 1 lock para a 1a pessoa; um SEGUNDO lock, diferente, para a 2a pessoa.
    expect(umaPessoa).toHaveLength(1);
    expect(duasPessoas).toHaveLength(2);
    expect(new Set(duasPessoas.map((l) => `${l.classid}/${l.objid}`)).size).toBe(2);

    // E o lock cai sozinho no fim da transacao (xact), sem unlock explicito.
    expect(await H.qn(d, `select 1 from pg_locks where locktype = 'advisory'`)).toEqual([]);

    console.log("EVIDENCIA lock: 1 pessoa =", umaPessoa.length, "locks; 2 pessoas =", duasPessoas.length, "locks distintos");
    await d.close();
  });

  it("duas inclusoes da mesma pessoa na mesma transacao respeitam o limite", async () => {
    // PGlite tem uma unica conexao, entao nao da para interpor duas transacoes
    // de verdade. O que este teste cobre e o outro lado da corrida: varias
    // inclusoes dentro de UMA transacao, onde a contagem tem de enxergar o que
    // ainda nao foi commitado. Se o gatilho contasse so o commitado, passariam 4.
    const d = await base();
    await d.exec("begin");
    const feitas = [];
    for (const t of ["C1", "C2", "C3", "C4"]) {
      try {
        await d.query(`insert into public.portal_playlist (titulo, artista, youtube_id, adicionado_por, adicionado_por_email)
                       values ($1,'A','aaaaaaaaaaa','Luana',$2)`, [t, H.LUANA]);
        feitas.push({ t, ok: true });
      } catch (e) {
        feitas.push({ t, ok: false, code: e.code });
        await d.exec("rollback");
        break;
      }
    }
    expect(feitas).toEqual([
      { t: "C1", ok: true }, { t: "C2", ok: true }, { t: "C3", ok: true },
      { t: "C4", ok: false, code: "PL003" },
    ]);
    await d.close();
  });
});

describe("policies existentes continuam valendo (nao foram alteradas pelo A1)", () => {
  it("ninguem insere no nome de outra pessoa", async () => {
    const d = await base();
    const r = await H.inserir(d, H.LUANA, "Tentando como Mauricio", { comoEmail: H.MAURICIO });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501"); // insufficient_privilege (RLS)
    await d.close();
  });

  it("um operador nao remove a musica de outro", async () => {
    const d = await base();
    const r = await H.atualizar(d, H.LUANA, H.REAIS[1].id, "ativo = false", []); // musica do Mauricio
    // A policy de UPDATE nem deixa a linha ser vista para alteracao: 0 linhas afetadas.
    expect(r.ok).toBe(true);
    expect(await H.q1(d, `select ativo from public.portal_playlist where id = $1`, [H.REAIS[1].id]))
      .toEqual({ ativo: true }); // segue ativa
    await d.close();
  });

  it("a gestao pode remover a musica de outra pessoa (policy portal_playlist_remover)", async () => {
    const d = await base();
    const r = await H.atualizar(d, H.AMANDA, H.REAIS[1].id, "ativo = false", []);
    expect(r.ok).toBe(true);
    expect(await H.q1(d, `select ativo from public.portal_playlist where id = $1`, [H.REAIS[1].id]))
      .toEqual({ ativo: false });
    await d.close();
  });
});

describe("rollback", () => {
  it("volta ao estado anterior quando os dados permitem", async () => {
    const d = await H.montarAntesDoA1();
    const antes = await H.retrato(d);
    const defAntes = await H.q1(d, `select column_default from information_schema.columns
      where table_schema='public' and table_name='portal_playlist' and column_name='semana_chave'`);

    await H.aplicarA1(d);
    await d.exec(H.ROLL(H.A1));

    expect(await H.retrato(d)).toEqual(antes);                   // 3 linhas reais intactas
    expect(await H.qn(d, `select conname from pg_constraint
      where conrelid = 'public.portal_playlist'::regclass and contype = 'u'`))
      .toEqual([{ conname: "portal_playlist_adicionado_por_email_semana_chave_key" }]);
    expect(await H.qn(d, `select tgname from pg_trigger
      where tgrelid = 'public.portal_playlist'::regclass and not tgisinternal`)).toEqual([]);
    expect(await H.qn(d, `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and proname='portal_playlist_limite_tres'`)).toEqual([]);
    expect((await H.q1(d, `select column_default from information_schema.columns
      where table_schema='public' and table_name='portal_playlist' and column_name='semana_chave'`)).column_default)
      .toBe(defAntes.column_default);                            // default original de volta

    await d.close();
  });

  it("falha FECHADO, sem tocar em nada, se houver 2 musicas da mesma pessoa na semana", async () => {
    const d = await base();
    expect((await H.inserir(d, H.LUANA, "Semana dupla 1")).ok).toBe(true);
    expect((await H.inserir(d, H.LUANA, "Semana dupla 2")).ok).toBe(true);

    let erro = null;
    try { await d.exec(H.ROLL(H.A1)); } catch (e) { erro = e; }

    expect(erro).not.toBeNull();
    expect(erro.code).toBe("PL004");
    expect(String(erro.message)).toContain(H.LUANA);

    // Nada foi desfeito: o gatilho do A1 segue no lugar e o limite segue valendo.
    expect(await H.qn(d, `select tgname from pg_trigger
      where tgrelid = 'public.portal_playlist'::regclass and not tgisinternal`))
      .toEqual([{ tgname: "portal_playlist_limite_tres_trg" }]);
    expect(await H.qn(d, `select conname from pg_constraint
      where conrelid = 'public.portal_playlist'::regclass and contype = 'u'`)).toEqual([]);

    await d.close();
  });
});

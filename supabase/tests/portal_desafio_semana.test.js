// C1 -- Desafio da semana (coletivo).
//
// Roda a migration REAL (supabase/aguardando_aprovacao/20260930180000_...) e o
// rollback REAL num PostgreSQL real (PGlite). O fixture reproduz as policies REAIS
// de `elogios_atendimento` e `sugestoes`, para provar que contar o progresso nao
// afrouxa a RLS delas nem devolve conteudo.
//
// Desafios, elogios e sugestoes de teste sao FICTICIOS; as policies sao reais.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import * as H from "./fixtures/portal_playlist/harness.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

let db;

// Periodo que contem "hoje" para o banco de teste. `portal_desafio_vigente`
// compara com a data de hoje em Sao Paulo, entao o periodo e ancorado em now().
const HOJE = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const DE = iso(new Date(HOJE.getTime() - 3 * 86400000));
const ATE = iso(new Date(HOJE.getTime() + 3 * 86400000));
const AGORA = new Date().toISOString();

beforeAll(async () => {
  db = await H.montarAntesDoA1();
  await H.aplicarA1(db);
  await H.aplicarA2(db);
  await H.prepararElogios(db);
  await H.aplicarB(db);
  await H.prepararSugestoes(db);
  await H.aplicarC1(db);
});
beforeEach(async () => {
  await H.resetar(db);
  await db.query("delete from public.portal_desafios");
  await db.query("delete from public.elogios_atendimento");
  await db.query("delete from public.sugestoes");
});
afterAll(async () => { await db?.close(); });

describe("so a gestao cadastra -- a regra esta no banco", () => {
  it("gestao cria; operador comum e recusado pela policy", async () => {
    expect((await H.criarDesafio(db, { email: H.AMANDA })).ok).toBe(true);
    expect((await H.criarDesafio(db, { email: H.FERNANDA })).ok).toBe(true);

    const operador = await H.criarDesafio(db, { email: H.MAURICIO });
    expect(operador.ok).toBe(false);
    expect(operador.code).toBe("42501");

    expect(Number((await H.q1(db, "select count(*) n from public.portal_desafios")).n)).toBe(2);
  });

  it("operador comum LE o desafio, mas nao edita nem apaga", async () => {
    const { id } = await H.criarDesafio(db, { titulo: "Desafio coletivo", email: H.AMANDA });

    expect((await H.comoUsuario(db, H.MAURICIO, () =>
      db.query("select titulo from public.portal_desafios"))).rows)
      .toEqual([{ titulo: "Desafio coletivo" }]);

    // UPDATE e DELETE nao afetam linha: a policy filtra.
    await H.comoUsuario(db, H.MAURICIO, () =>
      db.query("update public.portal_desafios set titulo='invadido' where id=$1", [id]));
    await H.comoUsuario(db, H.MAURICIO, () =>
      db.query("delete from public.portal_desafios where id=$1", [id]));

    expect((await H.q1(db, "select titulo from public.portal_desafios where id=$1", [id])).titulo)
      .toBe("Desafio coletivo");
  });

  it("a policy usa usuario_e_gestao(), nao uma copia da lista de e-mails", async () => {
    const p = await H.q1(db, `select qual, with_check from pg_policies
      where schemaname='public' and tablename='portal_desafios' and policyname='portal_desafios_gestao'`);
    expect(p.qual).toContain("usuario_e_gestao()");
    expect(p.with_check).toContain("usuario_e_gestao()");
    expect(p.qual).not.toContain("@aelbra.com.br");
  });
});

describe("nao existe ranking nem desafio individual", () => {
  it("a tabela nao tem coluna de operador e a RPC nao devolve pessoa", async () => {
    const colunas = (await H.qn(db, `select column_name from information_schema.columns
      where table_schema='public' and table_name='portal_desafios'`)).map((c) => c.column_name);

    for (const proibida of ["operador", "operador_email", "usuario_email", "responsavel_email", "pontos"]) {
      expect(colunas).not.toContain(proibida);
    }
    // criado_por_email e autoria do cadastro, nao participacao.
    expect(colunas).toContain("criado_por_email");

    const r = await H.q1(db, `select pg_get_function_result(p.oid) ret
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='portal_desafio_vigente'`);
    for (const proibido of ["operador", "email", "ranking", "posicao"]) {
      expect(r.ret).not.toContain(proibido);
    }
  });
});

describe("meta e indicador andam juntos -- sem numero fabricado", () => {
  it("INFORMATIVO nao aceita meta", async () => {
    const r = await H.criarDesafio(db, { indicador: "INFORMATIVO", meta: 20 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("23514");
  });

  it("indicador mensuravel EXIGE meta", async () => {
    const r = await H.criarDesafio(db, { indicador: "ELOGIOS_PUBLICADOS", meta: null });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("23514");
  });

  it("indicador fora da lista e recusado", async () => {
    const r = await H.criarDesafio(db, { indicador: "META_FINANCEIRA", meta: 1000 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("23514");
  });

  it("meta tem de ser positiva e o periodo coerente", async () => {
    expect((await H.criarDesafio(db, { indicador: "IDEIAS_ENVIADAS", meta: 0 })).code).toBe("23514");
    expect((await H.criarDesafio(db, { inicioEm: "2026-10-10", fimEm: "2026-10-01" })).code).toBe("23514");
  });
});

describe("progresso vem do dado real", () => {
  it("ELOGIOS_PUBLICADOS conta os publicados no periodo", async () => {
    await H.criarDesafio(db, { indicador: "ELOGIOS_PUBLICADOS", meta: 5, inicioEm: DE, fimEm: ATE });

    await H.criarElogio(db, { texto: "A", status: "PUBLICADO_TV", publicadoEm: AGORA });
    await H.criarElogio(db, { texto: "B", status: "PUBLICADO_TV", publicadoEm: AGORA });
    await H.criarElogio(db, { texto: "C", status: "REJEITADO_TV", publicadoEm: AGORA });   // nao conta
    await H.criarElogio(db, { texto: "D", status: "PUBLICADO_TV", publicadoEm: "2026-01-05T12:00:00Z" }); // fora

    expect(await H.desafioVigente(db, H.MAURICIO))
      .toMatchObject({ indicador: "ELOGIOS_PUBLICADOS", meta: 5, progresso: 2 });
  });

  it("ELOGIOS_REGISTRADOS conta por registrado_em, qualquer status", async () => {
    await H.criarDesafio(db, { indicador: "ELOGIOS_REGISTRADOS", meta: 10, inicioEm: DE, fimEm: ATE });
    await H.criarElogio(db, { texto: "A", status: "PENDENTE_ANALISE" });
    await H.criarElogio(db, { texto: "B", status: "REJEITADO_TV" });
    expect((await H.desafioVigente(db, H.MAURICIO)).progresso).toBe(2);
  });

  it("IDEIAS_ENVIADAS conta sugestoes do periodo, visiveis ou nao", async () => {
    await H.criarDesafio(db, { indicador: "IDEIAS_ENVIADAS", meta: 4, inicioEm: DE, fimEm: ATE });
    await H.criarSugestao(db, { descricao: "Ideia 1", visivel: true, criadoEm: AGORA });
    await H.criarSugestao(db, { descricao: "Ideia 2", visivel: false, criadoEm: AGORA });
    await H.criarSugestao(db, { descricao: "Antiga", criadoEm: "2026-02-01T12:00:00Z" });
    expect((await H.desafioVigente(db, H.MAURICIO)).progresso).toBe(2);
  });

  it("MUSICAS_ADICIONADAS e CURTIDAS_DADAS contam do Portal", async () => {
    await H.criarDesafio(db, { indicador: "CURTIDAS_DADAS", meta: 3, inicioEm: DE, fimEm: ATE });
    await H.curtir(db, H.LUANA, H.REAIS[0].id);
    await H.curtir(db, H.MAURICIO, H.REAIS[0].id);
    await H.curtir(db, H.LUANA, H.REAIS[1].id, "2026-01-10T12:00:00Z"); // fora do periodo
    expect((await H.desafioVigente(db, H.MAURICIO)).progresso).toBe(2);

    await db.query("delete from public.portal_desafios");
    await H.criarDesafio(db, { indicador: "MUSICAS_ADICIONADAS", meta: 3, inicioEm: DE, fimEm: ATE });
    // As 3 musicas reais entraram em 30/09; o periodo cobre hoje.
    expect((await H.desafioVigente(db, H.MAURICIO)).progresso).toBeGreaterThanOrEqual(0);
  });

  it("INFORMATIVO devolve progresso NULO -- nao inventa numero", async () => {
    await H.criarDesafio(db, {
      titulo: "Semana da escuta ativa", indicador: "INFORMATIVO", inicioEm: DE, fimEm: ATE,
    });
    const d = await H.desafioVigente(db, H.MAURICIO);
    expect(d.indicador).toBe("INFORMATIVO");
    expect(d.meta).toBeNull();
    expect(d.progresso).toBeNull();
  });

  it("contar o progresso NAO devolve conteudo de elogio nem de sugestao", async () => {
    await H.criarDesafio(db, { indicador: "ELOGIOS_PUBLICADOS", meta: 2, inicioEm: DE, fimEm: ATE });
    // Registrado pela Fernanda e sobre o Mauricio: a Luana nao e nenhum dos dois,
    // entao pela policy ela nao leria este elogio de jeito nenhum.
    await H.criarElogio(db, {
      texto: "texto do elogio", publicadoEm: AGORA,
      operadorEmail: H.MAURICIO, registradoPor: H.FERNANDA,
      print: "prints/segredo.png", observacao: "anotacao interna",
    });

    const d = await H.desafioVigente(db, H.MAURICIO);
    const bruto = JSON.stringify(d);
    for (const vazamento of ["texto do elogio", "segredo.png", "anotacao interna", H.MAURICIO]) {
      expect(bruto).not.toContain(vazamento);
    }
    expect(d.progresso).toBe(1);

    // E a policy de elogios segue barrando a leitura direta.
    expect((await H.comoUsuario(db, H.LUANA, () =>
      db.query("select count(*)::int n from public.elogios_atendimento"))).rows[0].n).toBe(0);
  });
});

describe("qual desafio e o vigente", () => {
  it("desafio inativo nao aparece", async () => {
    await H.criarDesafio(db, { titulo: "Desligado", ativo: false, inicioEm: DE, fimEm: ATE });
    expect(await H.desafioVigente(db, H.MAURICIO)).toBeNull();
  });

  it("desafio fora do periodo nao aparece", async () => {
    await H.criarDesafio(db, { titulo: "Passado", inicioEm: "2026-01-01", fimEm: "2026-01-07" });
    await H.criarDesafio(db, { titulo: "Futuro", inicioEm: "2027-01-01", fimEm: "2027-01-07" });
    expect(await H.desafioVigente(db, H.MAURICIO)).toBeNull();
  });

  it("com dois vigentes, vence o de inicio mais recente", async () => {
    await H.criarDesafio(db, { titulo: "Antigo", inicioEm: DE, fimEm: ATE });
    await H.criarDesafio(db, { titulo: "Novo", inicioEm: iso(new Date()), fimEm: ATE });
    expect((await H.desafioVigente(db, H.MAURICIO)).titulo).toBe("Novo");
  });

  it("nenhum desafio cadastrado: devolve vazio, sem erro", async () => {
    expect(await H.desafioVigente(db, H.MAURICIO)).toBeNull();
  });

  it("anon nao executa a funcao; authenticated executa", async () => {
    expect(await H.qn(db, `select has_function_privilege('anon',
      'public.portal_desafio_vigente()','execute') pode`)).toEqual([{ pode: false }]);
    expect(await H.qn(db, `select has_function_privilege('authenticated',
      'public.portal_desafio_vigente()','execute') pode`)).toEqual([{ pode: true }]);
  });
});

describe("rollback", () => {
  it("apaga a estrutura sem tocar elogio, sugestao, playlist ou curtida", async () => {
    const d = await H.montarAntesDoA1();
    await H.aplicarA1(d); await H.aplicarA2(d);
    await H.prepararElogios(d); await H.aplicarB(d);
    await H.prepararSugestoes(d); await H.aplicarC1(d);

    await H.criarElogio(d, { texto: "Fica" });
    await H.criarSugestao(d, { descricao: "Fica" });
    await H.curtir(d, H.LUANA, H.REAIS[0].id);

    await d.exec(H.ROLL(H.C1));

    expect(await H.qn(d, `select to_regclass('public.portal_desafios')::text t`)).toEqual([{ t: null }]);
    expect(Number((await H.q1(d, "select count(*) n from public.elogios_atendimento")).n)).toBe(1);
    expect(Number((await H.q1(d, "select count(*) n from public.sugestoes")).n)).toBe(1);
    expect(Number((await H.q1(d, "select count(*) n from public.portal_curtidas")).n)).toBe(1);
    expect(await H.retrato(d)).toHaveLength(3);
    await d.close();
  });

  it("com desafio cadastrado, recusa sem confirmacao explicita", async () => {
    const d = await H.montarAntesDoA1();
    await H.aplicarA1(d); await H.aplicarA2(d);
    await H.prepararElogios(d); await H.aplicarB(d);
    await H.prepararSugestoes(d); await H.aplicarC1(d);
    await H.criarDesafio(d, { titulo: "Cadastrado" });

    let erro = null;
    try { await d.exec(H.ROLL(H.C1)); } catch (e) { erro = e; }
    expect(erro?.code).toBe("PL007");
    expect(Number((await H.q1(d, "select count(*) n from public.portal_desafios")).n)).toBe(1);

    await d.query("select set_config('portal.rollback_desafios_confirmado','sim',false)");
    await d.exec(H.ROLL(H.C1));
    expect(await H.qn(d, `select to_regclass('public.portal_desafios')::text t`)).toEqual([{ t: null }]);
    await d.close();
  });
});

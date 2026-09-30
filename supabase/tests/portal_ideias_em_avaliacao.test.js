// Ideias da equipe: mural de ideias VIVAS, com envio pelo Portal.
//
// Roda a migration REAL (supabase/aguardando_aprovacao/20260930200000_...) e o
// rollback REAL num PostgreSQL real (PGlite), com as policies REAIS de
// `sugestoes` reproduzidas -- inclusive sugestoes_insert, que e o caminho do
// envio, e painel_negado como RESTRICTIVE.
//
// As sugestoes sao FICTICIAS. O que e real: as colunas, as policies e as funcoes.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import * as H from "./fixtures/portal_playlist/harness.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

let db;

beforeAll(async () => {
  db = await H.montarAntesDoA1();
  await H.aplicarA1(db);
  await H.aplicarA2(db);
  await H.prepararElogios(db);
  await H.aplicarB(db);
  await H.prepararSugestoes(db);
  await H.aplicarC1(db);
  await H.aplicarC2(db);
  await H.aplicarC3(db);
});
beforeEach(async () => {
  await H.resetar(db);
  await db.query("delete from public.sugestoes");
});
afterAll(async () => { await db?.close(); });

describe("ideia resolvida sai do mural", () => {
  it("FEITA e DESCARTADA nao aparecem, nem marcadas como visiveis", async () => {
    await H.criarSugestao(db, { descricao: "Ja implementada", status: "FEITA", visivel: true });
    await H.criarSugestao(db, { descricao: "Nao seguira", status: "DESCARTADA", visivel: true });
    await H.criarSugestao(db, { descricao: "Em avaliacao", status: "NOVA", visivel: true });
    await H.criarSugestao(db, { descricao: "Reaberta", status: "REABERTO", visivel: true });

    expect((await H.ideias(db, H.MAURICIO)).map((i) => i.descricao).sort())
      .toEqual(["Em avaliacao", "Reaberta"]);
  });

  it("status novo no Painel entra como ideia VIVA em vez de sumir", async () => {
    // Filtro negativo de proposito: se amanha a gestao criar EM_ANALISE ou
    // APROVADA, a ideia continua no mural em vez de desaparecer em silencio.
    await H.criarSugestao(db, { descricao: "Status futuro", status: "EM_ANALISE", visivel: true });
    await H.criarSugestao(db, { descricao: "Outro futuro", status: "APROVADA", visivel: true });
    await H.criarSugestao(db, { descricao: "Sem status", status: null, visivel: true });

    const m = await H.ideias(db, H.MAURICIO);
    expect(m.map((i) => i.descricao).sort()).toEqual(["Outro futuro", "Sem status", "Status futuro"]);
    expect(m.find((i) => i.descricao === "Sem status").status).toBe("NOVA");
  });

  it("o mural de producao hoje ficaria vazio -- as 17 atuais estao resolvidas", async () => {
    // Reproduz a proporcao real medida em 30/09: 16 FEITA + 1 DESCARTADA.
    for (let i = 0; i < 16; i++) await H.criarSugestao(db, { descricao: `Feita ${i}`, status: "FEITA", visivel: true });
    await H.criarSugestao(db, { descricao: "Descartada", status: "DESCARTADA", visivel: true });

    expect(await H.ideias(db, H.MAURICIO)).toEqual([]);
  });
});

describe("quem envia acompanha a propria ideia", () => {
  it("ve a propria antes de a gestao liberar, marcada como minha", async () => {
    const r = await H.enviarIdeia(db, H.LUANA, { descricao: "Filtro por unidade", nome: "Luana" });
    expect(r.ok).toBe(true);

    const minhas = await H.ideias(db, H.LUANA);
    expect(minhas).toHaveLength(1);
    expect(minhas[0]).toMatchObject({ descricao: "Filtro por unidade", autor: "Luana", status: "NOVA", minha: true });

    // E a equipe NAO ve, porque a gestao ainda nao liberou.
    expect(await H.ideias(db, H.MAURICIO)).toEqual([]);
  });

  it("depois que a gestao libera, a equipe ve e deixa de ser 'minha' para os outros", async () => {
    const { id } = await H.enviarIdeia(db, H.LUANA, { descricao: "Aviso de pagamento no Prime" });
    await db.query("update public.sugestoes set visivel_equipe = true where id = $1", [id]);

    const daEquipe = await H.ideias(db, H.MAURICIO);
    expect(daEquipe).toHaveLength(1);
    expect(daEquipe[0].minha).toBe(false);

    const daAutora = await H.ideias(db, H.LUANA);
    expect(daAutora[0].minha).toBe(true);
  });

  it("uma pessoa nao ve a ideia nao liberada de outra", async () => {
    await H.enviarIdeia(db, H.LUANA, { descricao: "Segredo da Luana" });
    await H.enviarIdeia(db, H.MAURICIO, { descricao: "Segredo do Mauricio" });

    expect((await H.ideias(db, H.LUANA)).map((i) => i.descricao)).toEqual(["Segredo da Luana"]);
    expect((await H.ideias(db, H.MAURICIO)).map((i) => i.descricao)).toEqual(["Segredo do Mauricio"]);
  });

  it("ideia propria que vira FEITA sai do mural, como as outras", async () => {
    const { id } = await H.enviarIdeia(db, H.LUANA, { descricao: "Minha ideia" });
    expect(await H.ideias(db, H.LUANA)).toHaveLength(1);

    await db.query("update public.sugestoes set status = 'FEITA' where id = $1", [id]);
    expect(await H.ideias(db, H.LUANA)).toEqual([]);
  });
});

describe("o envio usa o caminho que ja existe", () => {
  it("entra em sugestoes como NOVA, invisivel, com tipo e tela marcando a origem", async () => {
    const { id } = await H.enviarIdeia(db, H.LUANA, { descricao: "Ideia do Portal", area: "Ambiente de trabalho" });

    const s = await H.q1(db, `select descricao, status, visivel_equipe, tipo, tela, area, autor_email, nome
                                from public.sugestoes where id = $1`, [id]);
    expect(s).toEqual({
      descricao: "Ideia do Portal", status: "NOVA", visivel_equipe: false,
      tipo: "Nova ideia", tela: "Portal — Ideias da equipe", area: "Ambiente de trabalho",
      autor_email: H.LUANA, nome: "Pessoa",
    });
  });

  it("ninguem envia no nome de outra pessoa", async () => {
    const r = await H.comoUsuario(db, H.LUANA, async () => {
      try {
        await db.query(`insert into public.sugestoes (descricao, autor_email, area, tipo)
                        values ('Forjada', $1, 'Atendimento', 'Nova ideia')`, [H.MAURICIO]);
        return { ok: true };
      } catch (e) { return { ok: false, code: e.code }; }
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
  });

  it("conta desativada nao envia e nao le", async () => {
    const r = await H.enviarIdeia(db, H.DESATIVADA, { descricao: "De conta desativada" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
    expect(await H.ideias(db, H.DESATIVADA)).toEqual([]);
  });
});

describe("o que a funcao NAO devolve continua o mesmo", () => {
  it("a assinatura ganha so `minha`, e nenhum campo interno", async () => {
    const r = await H.q1(db, `select pg_get_function_result(p.oid) ret
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='portal_ideias_equipe'`);

    expect(r.ret).toBe(
      "TABLE(id uuid, descricao text, autor text, criado_em timestamp with time zone, status text, curtidas integer, eu_curti boolean, minha boolean)");
    for (const proibido of ["email", "tratativa", "anexo", "prioridade", "tela", "area", "tipo", "motivo", "retorno", "validado"]) {
      expect(r.ret).not.toContain(proibido);
    }
  });

  it("nao vaza tratativa, anexo, prioridade nem e-mail", async () => {
    const { id } = await H.enviarIdeia(db, H.LUANA, { descricao: "Ideia com tratativa" });
    await db.query(`update public.sugestoes
                       set observacao_tratativa='decisao interna: adiar',
                           prioridade='CRITICA', anexo_path='anexos/segredo.png'
                     where id=$1`, [id]);

    const bruto = JSON.stringify(await H.ideias(db, H.LUANA));
    for (const v of ["decisao interna", "CRITICA", "segredo.png", H.LUANA]) {
      expect(bruto).not.toContain(v);
    }
  });

  it("a RLS de sugestoes segue intocada", async () => {
    expect((await H.qn(db, `select policyname from pg_policies
      where schemaname='public' and tablename='sugestoes' order by policyname`)).map((p) => p.policyname))
      .toEqual(["painel_negado", "sugestoes_insert", "sugestoes_select", "sugestoes_update"]);

    await H.enviarIdeia(db, H.LUANA, { descricao: "Ideia" });
    // A autora continua sem ler pela TABELA -- so pelo mural.
    expect((await H.comoUsuario(db, H.LUANA, () =>
      db.query("select count(*)::int n from public.sugestoes"))).rows[0].n).toBe(0);
    expect(await H.ideias(db, H.LUANA)).toHaveLength(1);
  });
});

describe("curtidas e ordenacao seguem valendo", () => {
  it("ordena por curtidas e por recentes, com a propria ideia incluida", async () => {
    const a = await H.enviarIdeia(db, H.LUANA, { descricao: "Antiga" });
    await db.query("update public.sugestoes set criado_em = '2026-09-01T12:00:00Z', visivel_equipe = true where id = $1", [a.id]);
    const b = await H.enviarIdeia(db, H.LUANA, { descricao: "Recente" });
    await db.query("update public.sugestoes set criado_em = '2026-09-28T12:00:00Z', visivel_equipe = true where id = $1", [b.id]);

    expect((await H.ideias(db, H.MAURICIO, "recentes")).map((i) => i.descricao)).toEqual(["Recente", "Antiga"]);

    await H.curtir(db, H.MAURICIO, a.id, null, "ideia");
    expect((await H.ideias(db, H.MAURICIO, "curtidas")).map((i) => [i.descricao, i.curtidas]))
      .toEqual([["Antiga", 1], ["Recente", 0]]);
  });
});

describe("rollback", () => {
  it("volta a versao anterior: sem `minha` e mostrando qualquer status", async () => {
    const d = await H.montarAntesDoA1();
    await H.aplicarA1(d); await H.aplicarA2(d);
    await H.prepararElogios(d); await H.aplicarB(d);
    await H.prepararSugestoes(d); await H.aplicarC1(d); await H.aplicarC2(d); await H.aplicarC3(d);

    await H.criarSugestao(d, { descricao: "Feita", status: "FEITA", visivel: true });
    await H.criarSugestao(d, { descricao: "Nova", status: "NOVA", visivel: true });
    expect((await H.ideias(d, H.MAURICIO)).map((i) => i.descricao)).toEqual(["Nova"]);

    await d.exec(H.ROLL(H.C3));

    // A versao antiga volta a mostrar a resolvida e perde a coluna `minha`.
    const depois = await H.ideias(d, H.MAURICIO);
    expect(depois.map((i) => i.descricao).sort()).toEqual(["Feita", "Nova"]);
    expect(Object.keys(depois[0])).not.toContain("minha");

    // Nenhuma sugestao foi apagada nem alterada.
    expect(Number((await H.q1(d, "select count(*) n from public.sugestoes")).n)).toBe(2);
    await d.close();
  });
});

// C2 -- Ideias da equipe.
//
// Roda a migration REAL (supabase/aguardando_aprovacao/20260930190000_...) e o
// rollback REAL num PostgreSQL real (PGlite). O fixture reproduz as policies REAIS
// de `sugestoes` -- inclusive `sugestoes_select`, que hoje so deixa a gestao ler --
// e o teste central e provar que o mural nao afrouxa nada disso e nao vaza campo
// interno.
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
});
beforeEach(async () => {
  await H.resetar(db);
  await db.query("delete from public.sugestoes");
});
afterAll(async () => { await db?.close(); });

async function comBanco(fn) {
  const d = await H.montarAntesDoA1();
  await H.aplicarA1(d); await H.aplicarA2(d);
  await H.prepararElogios(d); await H.aplicarB(d);
  await H.prepararSugestoes(d); await H.aplicarC1(d); await H.aplicarC2(d);
  try { return await fn(d); } finally { await d.close(); }
}

describe("a RLS de sugestoes NAO foi afrouxada", () => {
  it("segue igual, e a equipe continua sem ler sugestao pela tabela", async () => {
    expect((await H.qn(db, `select policyname from pg_policies
      where schemaname='public' and tablename='sugestoes' order by policyname`)).map((p) => p.policyname))
      .toEqual(["painel_negado", "sugestoes_insert", "sugestoes_select", "sugestoes_update"]);

    await H.criarSugestao(db, { descricao: "Ideia visivel", visivel: true, autorEmail: H.LUANA });

    // Gestao le pela tabela.
    expect((await H.comoUsuario(db, H.AMANDA, () =>
      db.query("select count(*)::int n from public.sugestoes"))).rows[0].n).toBe(1);

    // A propria autora NAO le pela tabela -- a policy e so gestao/fila.
    expect((await H.comoUsuario(db, H.LUANA, () =>
      db.query("select count(*)::int n from public.sugestoes"))).rows[0].n).toBe(0);

    // Mas LE pelo mural.
    expect(await H.ideias(db, H.LUANA)).toHaveLength(1);
  });
});

describe("o mural devolve so o necessario", () => {
  it("a assinatura tem 7 colunas e nenhuma sensivel", async () => {
    const r = await H.q1(db, `select pg_get_function_result(p.oid) ret
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='portal_ideias_equipe'`);

    expect(r.ret).toBe(
      "TABLE(id uuid, descricao text, autor text, criado_em timestamp with time zone, status text, curtidas integer, eu_curti boolean)");
    for (const proibido of ["email", "tratativa", "anexo", "prioridade", "tela", "area", "tipo", "motivo", "retorno", "validado"]) {
      expect(r.ret).not.toContain(proibido);
    }
  });

  it("nao vaza tratativa, anexo, prioridade nem e-mail do autor", async () => {
    await H.criarSugestao(db, {
      descricao: "Colocar filtro por unidade na carteira",
      autor: "Luana", autorEmail: H.LUANA, visivel: true,
      tratativa: "decisao interna: adiar para o proximo trimestre",
      prioridade: "CRITICA", tela: "PainelCarteira", anexo: "anexos/segredo.png",
    });

    const m = await H.ideias(db, H.MAURICIO);
    expect(m).toHaveLength(1);
    expect(Object.keys(m[0]).sort())
      .toEqual(["autor", "criado_em", "curtidas", "descricao", "eu_curti", "id", "status"]);

    const bruto = JSON.stringify(m[0]);
    for (const vazamento of ["decisao interna", "CRITICA", "PainelCarteira", "segredo.png", H.LUANA]) {
      expect(bruto).not.toContain(vazamento);
    }
    expect(m[0].autor).toBe("Luana"); // o NOME aparece; o e-mail nao
  });

  it("so entra o que a gestao marcou como visivel_equipe", async () => {
    await H.criarSugestao(db, { descricao: "Aparece", visivel: true });
    await H.criarSugestao(db, { descricao: "Nao aparece", visivel: false });

    expect((await H.ideias(db, H.MAURICIO)).map((i) => i.descricao)).toEqual(["Aparece"]);
  });

  it("a migration nao muda visivel_equipe nem status de nada", async () => {
    const id = await H.criarSugestao(db, { descricao: "Intacta", visivel: false, status: "NOVA" });
    const antes = await H.q1(db, "select visivel_equipe, status from public.sugestoes where id=$1", [id]);
    await H.aplicarC2(db); // reaplicar
    expect(await H.q1(db, "select visivel_equipe, status from public.sugestoes where id=$1", [id]))
      .toEqual(antes);
  });

  it("descricao vazia nao vira card fantasma", async () => {
    await H.criarSugestao(db, { descricao: "   ", visivel: true });
    await H.criarSugestao(db, { descricao: "Ideia de verdade", visivel: true });
    expect((await H.ideias(db, H.MAURICIO)).map((i) => i.descricao)).toEqual(["Ideia de verdade"]);
  });

  it("status real do fluxo sai como esta -- a migration nao inventa dominio", async () => {
    for (const s of ["NOVA", "FEITA", "DESCARTADA", "REABERTO"]) {
      await H.criarSugestao(db, { descricao: `Ideia ${s}`, status: s, visivel: true });
    }
    const status = (await H.ideias(db, H.MAURICIO)).map((i) => i.status).sort();
    expect(status).toEqual(["DESCARTADA", "FEITA", "NOVA", "REABERTO"]);
  });

  it("conta desativada e quem nao esta em usuarios nao leem o mural", async () => {
    await H.criarSugestao(db, { descricao: "Ideia", visivel: true });
    expect(await H.ideias(db, H.DESATIVADA)).toEqual([]);
    expect(await H.ideias(db, "estranho@fora.com")).toEqual([]);
    expect(await H.ideias(db, H.MAURICIO)).toHaveLength(1);
  });

  it("anon nao executa a funcao", async () => {
    expect(await H.qn(db, `select has_function_privilege('anon',
      'public.portal_ideias_equipe(text,integer)','execute') pode`)).toEqual([{ pode: false }]);
    expect(await H.qn(db, `select has_function_privilege('authenticated',
      'public.portal_ideias_equipe(text,integer)','execute') pode`)).toEqual([{ pode: true }]);
  });

  it("sem ideias visiveis: vazio, sem erro", async () => {
    expect(await H.ideias(db, H.MAURICIO)).toEqual([]);
  });
});

describe("ordenacao", () => {
  it("'recentes' e o padrao e ordena por data decrescente", async () => {
    await H.criarSugestao(db, { descricao: "Antiga", criadoEm: "2026-09-10T12:00:00Z" });
    await H.criarSugestao(db, { descricao: "Recente", criadoEm: "2026-09-28T12:00:00Z" });

    expect((await H.ideias(db, H.MAURICIO)).map((i) => i.descricao)).toEqual(["Recente", "Antiga"]);
    expect((await H.ideias(db, H.MAURICIO, "recentes")).map((i) => i.descricao)).toEqual(["Recente", "Antiga"]);
    expect((await H.ideias(db, H.MAURICIO, "QUALQUER_COISA")).map((i) => i.descricao)).toEqual(["Recente", "Antiga"]);
  });

  it("'curtidas' ordena por total, e empate cai para a mais recente", async () => {
    const antiga = await H.criarSugestao(db, { descricao: "Antiga", criadoEm: "2026-09-10T12:00:00Z" });
    const recente = await H.criarSugestao(db, { descricao: "Recente", criadoEm: "2026-09-28T12:00:00Z" });
    const campea = await H.criarSugestao(db, { descricao: "Campea", criadoEm: "2026-09-01T12:00:00Z" });

    for (const e of [H.LUANA, H.MAURICIO, H.AMANDA]) await H.curtir(db, e, campea, null, "ideia");
    await H.curtir(db, H.LUANA, antiga, null, "ideia");
    await H.curtir(db, H.LUANA, recente, null, "ideia");

    expect((await H.ideias(db, H.MAURICIO, "curtidas")).map((i) => [i.descricao, i.curtidas]))
      .toEqual([["Campea", 3], ["Recente", 1], ["Antiga", 1]]);
  });

  it("ideia sem curtida aparece com zero, nao some", async () => {
    await H.criarSugestao(db, { descricao: "Sem curtida" });
    expect(await H.ideias(db, H.MAURICIO, "curtidas"))
      .toMatchObject([{ descricao: "Sem curtida", curtidas: 0, eu_curti: false }]);
  });

  it("o limite e respeitado, com teto de 50 e piso de 1", async () => {
    for (let i = 1; i <= 5; i++) await H.criarSugestao(db, { descricao: `Ideia ${i}`, criadoEm: `2026-09-0${i}T12:00:00Z` });
    expect(await H.ideias(db, H.MAURICIO, null, 2)).toHaveLength(2);
    expect(await H.ideias(db, H.MAURICIO, null, 999)).toHaveLength(5);
    expect(await H.ideias(db, H.MAURICIO, null, 0)).toHaveLength(1);
  });
});

describe("curtidas em ideia", () => {
  it("alvo_tipo passa a aceitar ideia, e os anteriores continuam valendo", async () => {
    const i = await H.criarSugestao(db, { descricao: "Curtivel" });
    const e = await H.criarElogio(db, { texto: "Elogio" });

    expect((await H.curtir(db, H.LUANA, i, null, "ideia")).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA, e, null, "elogio")).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA, H.REAIS[0].id, null, "playlist")).ok).toBe(true);

    const r = await H.curtir(db, H.LUANA, i, null, "outra_coisa");
    expect(r.code).toBe("23514");
  });

  it("uma pessoa curte uma vez e pode retirar a propria curtida", async () => {
    const i = await H.criarSugestao(db, { descricao: "Curtivel" });

    expect((await H.curtir(db, H.LUANA, i, null, "ideia")).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA, i, null, "ideia")).code).toBe("23505");
    expect(await H.ideias(db, H.LUANA)).toMatchObject([{ curtidas: 1, eu_curti: true }]);

    // Outra pessoa ve a mesma contagem, mas eu_curti falso.
    expect(await H.ideias(db, H.MAURICIO)).toMatchObject([{ curtidas: 1, eu_curti: false }]);

    await H.descurtir(db, H.LUANA, i, "ideia");
    expect(await H.ideias(db, H.LUANA)).toMatchObject([{ curtidas: 0, eu_curti: false }]);
  });

  it("ninguem retira a curtida de outra pessoa", async () => {
    const i = await H.criarSugestao(db, { descricao: "Curtivel" });
    await H.curtir(db, H.MAURICIO, i, null, "ideia");
    await H.descurtir(db, H.LUANA, i, "ideia");
    expect(await H.ideias(db, H.MAURICIO)).toMatchObject([{ curtidas: 1, eu_curti: true }]);
  });
});

describe("rollback", () => {
  it("nao apaga sugestao e devolve o CHECK ao dominio do B", async () => {
    await comBanco(async (d) => {
      const i = await H.criarSugestao(d, { descricao: "Fica" });
      const e = await H.criarElogio(d, { texto: "Elogio fica" });
      await H.curtir(d, H.LUANA, e, null, "elogio");

      await d.exec(H.ROLL(H.C2));

      expect(Number((await H.q1(d, "select count(*) n from public.sugestoes")).n)).toBe(1);
      expect((await H.q1(d, "select descricao from public.sugestoes where id=$1", [i])).descricao).toBe("Fica");
      // Curtida de elogio preservada; 'ideia' volta a ser recusado.
      expect(Number((await H.q1(d, "select count(*) n from public.portal_curtidas")).n)).toBe(1);
      expect((await H.curtir(d, H.LUANA, i, null, "ideia")).code).toBe("23514");
      expect(await H.qn(d, `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and proname='portal_ideias_equipe'`)).toEqual([]);
    });
  });

  it("com curtida de ideia, recusa sem confirmacao explicita", async () => {
    await comBanco(async (d) => {
      const i = await H.criarSugestao(d, { descricao: "Curtida" });
      await H.curtir(d, H.LUANA, i, null, "ideia");

      let erro = null;
      try { await d.exec(H.ROLL(H.C2)); } catch (x) { erro = x; }
      expect(erro?.code).toBe("PL008");
      expect(Number((await H.q1(d, "select count(*) n from public.portal_curtidas")).n)).toBe(1);

      await d.query("select set_config('portal.rollback_curtidas_ideia_confirmado','sim',false)");
      await d.exec(H.ROLL(H.C2));
      expect(Number((await H.q1(d, "select count(*) n from public.portal_curtidas")).n)).toBe(0);
      expect(Number((await H.q1(d, "select count(*) n from public.sugestoes")).n)).toBe(1);
    });
  });
});

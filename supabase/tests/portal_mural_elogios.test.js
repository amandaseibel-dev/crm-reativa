// B -- Mural de elogios da equipe.
//
// Roda a migration REAL (supabase/aguardando_aprovacao/20260930170000_...) e o
// rollback REAL num PostgreSQL real (PGlite). O fixture reproduz a estrutura e as
// policies REAIS de producao para `elogios_atendimento`, inclusive a
// `elogios_select` que restringe a leitura -- e o teste central e justamente
// provar que o mural nao afrouxa nada disso e nao vaza campo sensivel.
//
// Os elogios sao FICTICIOS. O que e real: as colunas, as policies e as funcoes.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import * as H from "./fixtures/portal_playlist/harness.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

// Um banco por arquivo, com limpeza barata entre testes.
let db;

beforeAll(async () => {
  db = await H.montarAntesDoA1();
  await H.aplicarA1(db);
  await H.aplicarA2(db);
  await H.prepararElogios(db);
  await H.aplicarB(db);
});
beforeEach(async () => {
  await H.resetar(db);
  await db.query("delete from public.elogios_atendimento");
});
afterAll(async () => { await db?.close(); });

async function comBanco(fn) {
  const d = await H.montarAntesDoA1();
  await H.aplicarA1(d);
  await H.aplicarA2(d);
  await H.prepararElogios(d);
  await H.aplicarB(d);
  try { return await fn(d); } finally { await d.close(); }
}

describe("a policy de elogios_atendimento NAO foi afrouxada", () => {
  it("segue sendo a mesma, e a equipe continua sem ler elogio de terceiro", async () => {
    expect(await H.qn(db, `select policyname, cmd from pg_policies
      where schemaname='public' and tablename='elogios_atendimento' order by policyname`))
      .toEqual([{ policyname: "elogios_select", cmd: "SELECT" }]);

    await H.criarElogio(db, { texto: "Excelente atendimento.", operadorEmail: H.MAURICIO, registradoPor: H.LUANA });

    // Fernanda e gestao de elogios: le.
    expect((await H.comoUsuario(db, H.FERNANDA, () =>
      db.query("select count(*)::int n from public.elogios_atendimento"))).rows[0].n).toBe(1);

    // Mauricio foi o elogiado: le o proprio.
    expect((await H.comoUsuario(db, H.MAURICIO, () =>
      db.query("select count(*)::int n from public.elogios_atendimento"))).rows[0].n).toBe(1);

    // Um operador qualquer, que nao registrou nem foi elogiado: NAO le.
    await db.query("insert into public.usuarios (nome,email,perfil,ativo) values ('Olga','cobranca03@aelbra.com.br','operador',true) on conflict do nothing");
    expect((await H.comoUsuario(db, "cobranca03@aelbra.com.br", () =>
      db.query("select count(*)::int n from public.elogios_atendimento"))).rows[0].n).toBe(0);
  });
});

describe("o mural devolve so o necessario", () => {
  it("a assinatura devolve exatamente 4 colunas: id, texto, operador_nome, publicado_em", async () => {
    const r = await H.q1(db, `select pg_get_function_result(p.oid) as retorno
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname='portal_mural_elogios'`);

    expect(r.retorno).toBe(
      "TABLE(id uuid, texto text, operador_nome text, publicado_em timestamp with time zone)");

    // Nenhum campo sensivel na assinatura -- nao ha como pedir.
    for (const proibido of ["print", "observacao", "motivo", "email", "status", "aluno", "exibir", "arquivado"]) {
      expect(r.retorno).not.toContain(proibido);
    }
  });

  it("um operador que nao leria o elogio direto LE pelo mural, sem campo sensivel", async () => {
    await H.criarElogio(db, {
      texto: "Excelente atendimento, resolveu tudo rapidamente.",
      operador: "Mauricio", operadorEmail: H.MAURICIO, registradoPor: H.FERNANDA,
      print: "prints/segredo.png", observacao: "anotacao interna da gestao",
    });

    // Luana nao registrou e nao foi elogiada -- pela tabela nao ve nada.
    expect((await H.comoUsuario(db, H.LUANA, () =>
      db.query("select count(*)::int n from public.elogios_atendimento"))).rows[0].n).toBe(0);

    // Pelo mural, ve o reconhecimento.
    const m = await H.mural(db, H.LUANA);
    expect(m).toHaveLength(1);
    expect(m[0]).toEqual({
      id: expect.any(String),
      texto: "Excelente atendimento, resolveu tudo rapidamente.",
      operador_nome: "Mauricio",
      publicado_em: expect.anything(),
    });

    // E nada mais: nem print, nem observacao, nem e-mail, nem status.
    const bruto = JSON.stringify(m[0]);
    for (const vazamento of ["segredo.png", "anotacao interna", H.MAURICIO, H.FERNANDA, "PUBLICADO_TV"]) {
      expect(bruto).not.toContain(vazamento);
    }
    expect(Object.keys(m[0]).sort()).toEqual(["id", "operador_nome", "publicado_em", "texto"]);
  });

  it("so PUBLICADO_TV entra: rejeitado, aprovado, pendente e arquivado ficam fora", async () => {
    await H.criarElogio(db, { texto: "Publicado", status: "PUBLICADO_TV" });
    for (const s of ["REJEITADO_TV", "APROVADO_TV", "PENDENTE_ANALISE", "ARQUIVADO"]) {
      await H.criarElogio(db, { texto: `Texto de ${s}`, status: s, motivoRejeicao: "nao serve" });
    }

    const m = await H.mural(db, H.LUANA);
    expect(m.map((x) => x.texto)).toEqual(["Publicado"]);
    expect(JSON.stringify(m)).not.toContain("nao serve");
  });

  it("PUBLICADO_TV sem texto aprovado nao aparece -- e nunca cai para a observacao interna", async () => {
    // Este e o caso dos 4 de 5 elogios publicados que existem em producao hoje.
    await H.criarElogio(db, { texto: null, observacao: "o elogio esta so no print" });
    await H.criarElogio(db, { texto: "   ", observacao: "texto em branco" });
    await H.criarElogio(db, { texto: "Com texto aprovado" });

    const m = await H.mural(db, H.LUANA);
    expect(m.map((x) => x.texto)).toEqual(["Com texto aprovado"]);
    expect(JSON.stringify(m)).not.toContain("so no print");
  });

  it("texto sai sem espaco sobrando nas pontas", async () => {
    await H.criarElogio(db, { texto: "  Muito atencioso.  " });
    expect((await H.mural(db, H.LUANA))[0].texto).toBe("Muito atencioso.");
  });

  it("mais recentes primeiro, e o limite e respeitado e limitado a 50", async () => {
    for (let i = 1; i <= 5; i++) {
      await H.criarElogio(db, { texto: `Elogio ${i}`, publicadoEm: `2026-09-2${i}T12:00:00Z` });
    }
    expect((await H.mural(db, H.LUANA)).map((x) => x.texto))
      .toEqual(["Elogio 5", "Elogio 4", "Elogio 3", "Elogio 2", "Elogio 1"]);
    expect(await H.mural(db, H.LUANA, 2)).toHaveLength(2);
    expect(await H.mural(db, H.LUANA, 999)).toHaveLength(5);  // teto de 50 nao quebra
    expect(await H.mural(db, H.LUANA, 0)).toHaveLength(1);    // piso de 1
  });

  it("conta desativada nao le o mural", async () => {
    await H.criarElogio(db, { texto: "Reconhecimento" });
    expect(await H.mural(db, H.DESATIVADA)).toEqual([]);
    expect(await H.mural(db, H.LUANA)).toHaveLength(1);
  });

  it("quem nao esta em usuarios nao le o mural", async () => {
    await H.criarElogio(db, { texto: "Reconhecimento" });
    expect(await H.mural(db, "estranho@fora.com")).toEqual([]);
  });

  it("anon nao tem permissao de executar a funcao", async () => {
    expect(await H.qn(db, `select has_function_privilege('anon',
      'public.portal_mural_elogios(integer)', 'execute') as pode`)).toEqual([{ pode: false }]);
    expect(await H.qn(db, `select has_function_privilege('authenticated',
      'public.portal_mural_elogios(integer)', 'execute') as pode`)).toEqual([{ pode: true }]);
  });

  it("nenhum elogio publicado: mural vazio, sem erro", async () => {
    expect(await H.mural(db, H.LUANA)).toEqual([]);
  });
});

describe("curtidas em elogio", () => {
  it("alvo_tipo passa a aceitar elogio, e playlist continua valendo", async () => {
    const e = await H.criarElogio(db, { texto: "Curtivel" });
    expect((await H.curtir(db, H.LUANA, e, null, "elogio")).ok).toBe(true);
    expect((await H.curtir(db, H.LUANA, H.REAIS[0].id, null, "playlist")).ok).toBe(true);

    const r = await H.curtir(db, H.LUANA, e, null, "ideia");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("23514"); // ideia ainda nao
  });

  it("uma pessoa curte um elogio uma vez, e pode retirar a propria curtida", async () => {
    const e = await H.criarElogio(db, { texto: "Curtivel" });

    expect((await H.curtir(db, H.LUANA, e, null, "elogio")).ok).toBe(true);
    const repetida = await H.curtir(db, H.LUANA, e, null, "elogio");
    expect(repetida.ok).toBe(false);
    expect(repetida.code).toBe("23505");

    expect(await H.curtidasTotais(db, H.LUANA, "elogio"))
      .toEqual([{ alvo_id: e, curtidas: 1, eu_curti: true }]);

    await H.descurtir(db, H.LUANA, e, "elogio");
    expect(await H.curtidasTotais(db, H.LUANA, "elogio")).toEqual([]);
  });

  it("o total acumula entre semanas -- nao e contagem semanal", async () => {
    const e = await H.criarElogio(db, { texto: "Curtivel" });
    await H.curtir(db, H.LUANA,    e, "2026-08-10T12:00:00Z", "elogio");
    await H.curtir(db, H.MAURICIO, e, "2026-09-30T12:00:00Z", "elogio");

    expect(await H.curtidasTotais(db, H.LUANA, "elogio"))
      .toEqual([{ alvo_id: e, curtidas: 2, eu_curti: true }]);

    // A versao semanal do A2 veria so a desta semana -- por isso as duas existem.
    expect((await H.comoUsuario(db, H.LUANA, () =>
      db.query("select curtidas_semana from public.portal_curtidas_da_semana('elogio')"))).rows)
      .toEqual([{ curtidas_semana: 1 }]);
  });

  it("nao existe ranking de operador: o mural nao soma curtida por pessoa", async () => {
    // A funcao do mural nao devolve operador_email nem agrega por operador --
    // duas linhas do mesmo operador saem como dois elogios, nunca como um total.
    await H.criarElogio(db, { texto: "Primeiro", operador: "Mauricio", publicadoEm: "2026-09-20T12:00:00Z" });
    await H.criarElogio(db, { texto: "Segundo", operador: "Mauricio", publicadoEm: "2026-09-21T12:00:00Z" });

    const m = await H.mural(db, H.LUANA);
    expect(m).toHaveLength(2);
    expect(m.every((x) => x.operador_nome === "Mauricio")).toBe(true);
    expect(Object.keys(m[0])).not.toContain("total");
  });
});

describe("rollback", () => {
  it("nao apaga elogio e volta o CHECK quando nao ha curtida de elogio", async () => {
    await comBanco(async (d) => {
      await H.prepararElogios(d);
      const e = await H.criarElogio(d, { texto: "Fica" });
      await H.curtir(d, H.LUANA, H.REAIS[0].id, null, "playlist"); // curtida de playlist fica

      await d.exec(H.ROLL(H.B));

      expect(Number((await H.q1(d, "select count(*) n from public.elogios_atendimento")).n)).toBe(1);
      expect((await H.q1(d, "select texto_final_tv t from public.elogios_atendimento where id=$1", [e])).t).toBe("Fica");
      expect(Number((await H.q1(d, "select count(*) n from public.portal_curtidas")).n)).toBe(1);
      expect(await H.qn(d, `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and proname in ('portal_mural_elogios','portal_curtidas_totais')`)).toEqual([]);
      // E 'elogio' volta a ser recusado.
      expect((await H.curtir(d, H.LUANA, H.REAIS[1].id, null, "elogio")).code).toBe("23514");
    });
  });

  it("com curtida de elogio, recusa sem confirmacao explicita", async () => {
    await comBanco(async (d) => {
      await H.prepararElogios(d);
      const e = await H.criarElogio(d, { texto: "Curtido" });
      await H.curtir(d, H.LUANA, e, null, "elogio");

      let erro = null;
      try { await d.exec(H.ROLL(H.B)); } catch (x) { erro = x; }
      expect(erro?.code).toBe("PL006");
      expect(Number((await H.q1(d, "select count(*) n from public.portal_curtidas")).n)).toBe(1);

      // Com confirmacao, desfaz.
      await d.query("select set_config('portal.rollback_curtidas_elogio_confirmado','sim',false)");
      await d.exec(H.ROLL(H.B));
      expect(Number((await H.q1(d, "select count(*) n from public.portal_curtidas")).n)).toBe(0);
      expect(Number((await H.q1(d, "select count(*) n from public.elogios_atendimento")).n)).toBe(1);
    });
  });
});

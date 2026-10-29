// CARTEIRA GERAL — o patch ancorado das rotinas automáticas.
//
// A migration 20260925181823 não reescreve as funções automáticas: ela lê a
// definição viva, exige a âncora na contagem exata e troca só aquele trecho.
// Este teste prova o mecanismo em PostgreSQL real — inclusive que ele FALHA
// quando a função mudou, em vez de aplicar pela metade.
//
// As âncoras usadas na migration foram conferidas contra a definição de
// produção em 24/09/2026 (contagem: nivelamento_automatico_gestao 1,
// calibragem_simular_nivelamento_impl 1, reforcar_teto_operadores 1,
// nivelar_medias_progressivo 2, reposicao_carteira_processar 1,
// atribuir_responsavel_por_acordo 1).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIG = (n) => readFileSync(resolve(AQUI, "..", "migrations", `${n}.sql`), "utf8");

// Só o bloco do helper, sem os `perform` que dependem das funções de produção.
const MIGRACAO = MIG("20260925181823_carteira_geral_blindar_automacoes");
const SO_O_HELPER = MIGRACAO.slice(0, MIGRACAO.indexOf("do $patch$"));

let db;
beforeEach(async () => {
  db = new PGlite();
  await db.exec("create schema if not exists internal;");
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;
  `);
  await db.exec(SO_O_HELPER);
});

const alvo = (corpo) =>
  db.exec(`create or replace function public.alvo() returns int language plpgsql as $f$ ${corpo} $f$;`);
const fonte = async () =>
  (await db.query("select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='alvo'")).rows[0].d;

describe("patch ancorado", () => {
  it("troca só o trecho da âncora e preserva o resto", async () => {
    await alvo("begin -- comentario que precisa sobreviver\n  return 1; end;");
    await db.query("select internal.patch_funcao_ancorada('public','alvo','return 1;','return 2;',1)");

    const d = await fonte();
    expect(d).toContain("return 2;");
    expect(d).not.toContain("return 1;");
    expect(d).toContain("comentario que precisa sobreviver");
    expect((await db.query("select public.alvo() v")).rows[0].v).toBe(2);
  });

  it("aplica em todas as ocorrências quando a contagem esperada é maior que 1", async () => {
    // nivelar_medias_progressivo tem a mesma âncora duas vezes: a média e o laço.
    // Como lá, o texto novo ACRESCENTA ao trecho antigo em vez de encolhê-lo.
    await alvo("declare x int; begin x := 0; x := x + 1; x := x + 1; return x; end;");
    await db.query("select internal.patch_funcao_ancorada('public','alvo','x + 1','x + 1 + 9',2)");
    expect((await db.query("select public.alvo() v")).rows[0].v).toBe(20);
  });

  it("recusa patch ambíguo, em que o texto novo é pedaço da âncora", async () => {
    // Se o novo já aparece dentro do antigo, não dá para distinguir "aplicado"
    // de "nunca aplicado" — e o patch sairia em silêncio sem fazer nada.
    // "x + 1" está literalmente dentro de "x + 10".
    await alvo("declare x int; begin x := 0; x := x + 10; return x; end;");
    await expect(
      db.query("select internal.patch_funcao_ancorada('public','alvo','x + 10','x + 1',1)")
    ).rejects.toThrow(/patch ambiguo/);
    expect((await db.query("select public.alvo() v")).rows[0].v).toBe(10);
  });

  it("FALHA se a função mudou e a âncora não bate mais", async () => {
    await alvo("begin return 1; end;");
    await expect(
      db.query("select internal.patch_funcao_ancorada('public','alvo','return 99;','return 2;',1)")
    ).rejects.toThrow(/ocorrencia\(s\) da ancora, esperado/);
    // e não mexeu em nada
    expect((await db.query("select public.alvo() v")).rows[0].v).toBe(1);
  });

  it("FALHA se a âncora aparece mais vezes do que o esperado", async () => {
    await alvo("declare x int; begin x := 0; x := x + 1; x := x + 1; return x; end;");
    await expect(
      db.query("select internal.patch_funcao_ancorada('public','alvo','x + 1','x + 5',1)")
    ).rejects.toThrow(/tem 2 ocorrencia/);
    expect((await db.query("select public.alvo() v")).rows[0].v).toBe(2);
  });

  it("FALHA se a função não existe", async () => {
    await expect(
      db.query("select internal.patch_funcao_ancorada('public','nao_existe','a','b',1)")
    ).rejects.toThrow(/nao existe/);
  });

  it("é idempotente: rodar de novo não quebra nem duplica", async () => {
    await alvo("begin return 1; end;");
    await db.query("select internal.patch_funcao_ancorada('public','alvo','return 1;','return 2;',1)");
    // segunda rodada: a âncora já não existe mais, mas o patch reconhece que
    // está aplicado e sai sem erro — senão reaplicar a migration explodiria.
    await db.query("select internal.patch_funcao_ancorada('public','alvo','return 1;','return 2;',1)");
    expect((await db.query("select public.alvo() v")).rows[0].v).toBe(2);
  });

  it("o helper não fica acessível para o app", async () => {
    const acl = (await db.query(`
      select has_function_privilege('authenticated', p.oid, 'execute') a,
             has_function_privilege('anon', p.oid, 'execute') b
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='internal' and p.proname='patch_funcao_ancorada'`)).rows[0];
    expect(acl.a).toBe(false);
    expect(acl.b).toBe(false);
  });
});

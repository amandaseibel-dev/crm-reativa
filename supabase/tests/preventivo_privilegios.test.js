// PRIVILÉGIOS DAS FUNÇÕES DO PREVENTIVO.
//
// Em Postgres, toda função nova nasce com `EXECUTE` para `PUBLIC`. As três
// migrations de 28/09/2026 revogaram isso em 21 das 29 funções `preventivo_*`
// e esqueceram de 8 — o que só apareceu conferindo a ACL em produção depois de
// aplicar. Este arquivo trava as duas pontas: nenhuma função do módulo pode
// ficar aberta a PUBLIC, e nenhuma pode perder `authenticated`/`service_role`
// no caminho (revogar de `authenticated` já derrubou a tela da própria gestão
// em 12/09/2026).
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const TRES = [
  "supabase/migrations/20260928143743_preventivo_estrutura.sql",
  "supabase/migrations/20260928143843_preventivo_importacao.sql",
  "supabase/migrations/20260928143943_preventivo_sincronizacao_acoes.sql",
];
const QUARTA = "supabase/migrations/20260928175656_preventivo_fechar_execute_publico.sql";
const ROLLBACK = "supabase/rollbacks/20260928175656_preventivo_fechar_execute_publico.rollback.sql";

// A interna só precisa de service_role; as demais precisam de authenticated.
const SO_SERVICE_ROLE = "preventivo_lote_processar";

async function novoBanco({ aplicarQuarta = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create table public.usuarios (email text, ativo boolean default true);
  `);
  for (const f of TRES) await db.exec(ler(f));
  if (aplicarQuarta) await db.exec(ler(QUARTA));
  return db;
}

const lista = async (db, sql) => (await db.query(sql)).rows.map((r) => Object.values(r)[0]);

const COM_PUBLIC = `
  select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'preventivo\\_%'
     and (p.proacl is null or exists (select 1 from unnest(p.proacl) a where a::text like '=X/%'))
   order by 1`;

const SEM_PAPEL = (papel) => `
  select p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'preventivo\\_%'
     and not exists (select 1 from unnest(p.proacl) a where a::text like '${papel}=X/%')
   order by 1`;

describe("as 3 migrations aplicadas sozinhas", () => {
  let db;
  beforeEach(async () => { db = await novoBanco({ aplicarQuarta: false }); });

  it("deixam exatamente 8 funções utilitárias abertas a PUBLIC", async () => {
    // É o defeito medido em produção. Fica registrado aqui para que a 4ª
    // migration tenha um antes e um depois demonstráveis.
    expect(await lista(db, COM_PUBLIC)).toEqual([
      "preventivo_celulares(text)",
      "preventivo_dias_atraso(date)",
      "preventivo_email_valido(text)",
      "preventivo_emails(text)",
      "preventivo_hoje()",
      "preventivo_limite_dias()",
      "preventivo_na_janela(date)",
      "preventivo_normalizar_celular(text)",
    ]);
  });

  it("nenhuma das 8 lê tabela — por isso o que vaza é cálculo, não dado", async () => {
    const corpos = await lista(db, `
      select pg_get_functiondef(p.oid)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('preventivo_hoje','preventivo_limite_dias','preventivo_dias_atraso',
                           'preventivo_na_janela','preventivo_normalizar_celular',
                           'preventivo_email_valido','preventivo_celulares','preventivo_emails')`);
    expect(corpos).toHaveLength(8);
    for (const c of corpos) {
      expect([c.slice(0, 60), /\bprev_[a-z]|\busuarios\b/i.test(c)]).toEqual([c.slice(0, 60), false]);
    }
  });

  it("nenhuma das 8 é SECURITY DEFINER", async () => {
    const definer = await lista(db, `
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
         and p.proname in ('preventivo_hoje','preventivo_limite_dias','preventivo_dias_atraso',
                           'preventivo_na_janela','preventivo_normalizar_celular',
                           'preventivo_email_valido','preventivo_celulares','preventivo_emails')`);
    expect(definer).toEqual([]);
  });

  it("nenhuma das 8 aparece em default ou check de constraint", async () => {
    // Revogar EXECUTE de função usada em CHECK quebraria INSERT. Não é o caso.
    const usadas = await lista(db, `
      select c.conname from pg_constraint c
       where pg_get_constraintdef(c.oid) ~ 'preventivo_(hoje|limite_dias|dias_atraso|na_janela|normalizar_celular|email_valido|celulares|emails)'`);
    expect(usadas).toEqual([]);
  });
});

describe("a 4ª migration, só de privilégios", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("fecha PUBLIC em TODAS as funções do módulo", async () => {
    expect(await lista(db, COM_PUBLIC)).toEqual([]);
  });

  it("não tira authenticated de ninguém (exceto a função interna)", async () => {
    const sem = await lista(db, SEM_PAPEL("authenticated"));
    expect(sem).toEqual([SO_SERVICE_ROLE]);
  });

  it("não tira service_role de ninguém", async () => {
    expect(await lista(db, SEM_PAPEL("service_role"))).toEqual([]);
  });

  it("não cria, não altera e não apaga objeto nenhum", async () => {
    const antes = await novoBanco({ aplicarQuarta: false });
    const impressao = async (d) => (await d.query(`
      select md5(string_agg(t, ',' order by t)) v from (
        select c.relname || ':' || c.relkind::text t from pg_class c
          join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
        union all
        select p.oid::regprocedure::text || ':' || pg_get_functiondef(p.oid) from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
        union all
        select conname || ':' || pg_get_constraintdef(oid) from pg_constraint
        union all
        select polname || ':' || coalesce(pg_get_expr(polqual, polrelid), '') from pg_policy) x`)).rows[0].v;
    expect(await impressao(db)).toBe(await impressao(antes));
  });

  it("o rollback devolve exatamente o estado anterior", async () => {
    await db.exec(ler(ROLLBACK));
    expect(await lista(db, COM_PUBLIC)).toEqual([
      "preventivo_celulares(text)",
      "preventivo_dias_atraso(date)",
      "preventivo_email_valido(text)",
      "preventivo_emails(text)",
      "preventivo_hoje()",
      "preventivo_limite_dias()",
      "preventivo_na_janela(date)",
      "preventivo_normalizar_celular(text)",
    ]);
    expect(await lista(db, SEM_PAPEL("authenticated"))).toEqual([SO_SERVICE_ROLE]);
  });
});

// STATUS ACADÊMICO POR SAFRA, agora com dinheiro — as travas da migration
// 20261007130000 em PostgreSQL real.
//
// O que este teste prova, e por que cada um importa:
//
//  - as quatro funções e a tabela nascem (a SINTAXE do corpo é validada pelo
//    validador do plpgsql no `create function`, inclusive os sete
//    `regexp_replace(..., '\D', ...)` do recorte 2024/2025, que já chegaram
//    dobrados ao banco em outra ocasião);
//  - a ACL fecha: tabela sem nada para `authenticated`/`anon` — inclusive
//    TRUNCATE, que RLS não cobre — e função de leitura fechada para `anon`;
//  - o FECHAMENTO: a quebra por status soma exatamente o total da safra. É este
//    o compromisso do card, em vez de número decorado;
//  - a trava de EQUIVALÊNCIA: se o universo por título divergir do universo
//    oficial por aluno, o recálculo ABORTA em vez de gravar uma carteira
//    diferente da que a tela mostra;
//  - `(sem situação importada)` é linha REAL, não resto;
//  - "Matriculado Curso Normal" e "Aguardando Matrícula" ficam SEPARADOS;
//  - não existe total das três safras no payload (há CPF em mais de uma).
//
// Os números deste teste são INVENTADOS. Produção não entra em arquivo
// versionado.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRACAO = readFileSync(
  resolve(AQUI, "..", "migrations", "20261007130000_carteira_academico_saldo_por_status.sql"),
  "utf8",
);

// A migration inteira menos a primeira fotografia e o cron: as duas dependem de
// tabelas de produção que não existem aqui. Tudo o que é objeto novo entra.
const SEM_PRIMEIRA_FOTO = MIGRACAO.slice(0, MIGRACAO.indexOf("-- --------------------------------------------------- 5."));

let db;

// o universo oficial que a assercao compara (controlado pelo teste)
const universo = (n) =>
  db.exec(`create or replace function public.carteira_academico_universo(p_ano text, p_semestre text default null)
           returns table(aluno_id uuid, cpf text) language sql stable as $f$
             select null::uuid, g::text from generate_series(1, ${n}) g $f$;`);

// o detalhe por titulo que o recalculo consome (controlado pelo teste)
const detalhe = (linhas) =>
  db.exec(`create or replace function public.carteira_academico_saldo_detalhe(p_ano text, p_semestre text default null)
           returns table(cpf text, aluno_id uuid, titulos integer, saldo numeric)
           language sql stable as $f$ ${linhas} $f$;`);

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    create schema if not exists auth;
    create schema if not exists cron;
    create table cron.job (jobname text);
    create function cron.schedule(a text, b text, c text) returns bigint language sql as $f$ select 1::bigint $f$;
    create function auth.role() returns text language sql stable as $f$ select 'service_role'::text $f$;
    create function auth.jwt() returns jsonb language sql stable as $f$ select null::jsonb $f$;
    create function public.usuario_e_gestao() returns boolean language sql stable as $f$ select true $f$;
    create table public.pode (ok boolean);
    insert into public.pode values (true);
    create function public.carteira_2026_1_pode_ler() returns boolean language sql stable
      as $f$ select coalesce((select ok from public.pode limit 1), false) $f$;
    create table public.alunos (id uuid primary key, situacao_academica text,
                                academico_atualizado_em timestamptz);
    create table public.carteira_saldo_historico_snapshot (payload jsonb, gerado_em timestamptz);
  `);
  await universo(3);
  await db.exec(SEM_PRIMEIRA_FOTO);
});

const ler = async () => (await db.query("select public.carteira_academico_saldo_ler() j")).rows[0].j;
const safra = (j, r) => j.safras.find((s) => s.recorte === r);
const linha = (s, nome) => s.linhas.find((l) => l.situacao === nome);

describe("objetos e ACL", () => {
  it("cria as quatro funções e a tabela", async () => {
    const { rows } = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'carteira_academico_saldo%' order by 1`);
    expect(rows.map((r) => r.proname)).toEqual([
      "carteira_academico_saldo_detalhe",
      "carteira_academico_saldo_ler",
      "carteira_academico_saldo_recalcular",
    ]);
    const t = await db.query(`select relrowsecurity from pg_class
                               where relname = 'carteira_academico_saldo_snapshot'`);
    expect(t.rows[0].relrowsecurity).toBe(true);
  });

  it("a tabela não dá nada a authenticated nem anon — TRUNCATE incluído", async () => {
    const { rows } = await db.query(`
      select grantee, privilege_type from information_schema.role_table_grants
       where table_name = 'carteira_academico_saldo_snapshot'
         and grantee in ('authenticated','anon','PUBLIC')`);
    expect(rows).toEqual([]);
    const sr = await db.query(`
      select privilege_type from information_schema.role_table_grants
       where table_name = 'carteira_academico_saldo_snapshot' and grantee = 'service_role'
       order by 1`);
    expect(sr.rows.map((r) => r.privilege_type).sort())
      .toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
  });

  it("as funções ficam fechadas para anon e abertas para authenticated", async () => {
    const { rows } = await db.query(`
      select r.routine_name, r.grantee from information_schema.routine_privileges r
       where r.routine_name like 'carteira_academico_saldo%'
         and r.grantee in ('anon','authenticated','PUBLIC')
       order by 1, 2`);
    expect(rows.filter((r) => r.grantee === "anon")).toEqual([]);
    expect(rows.filter((r) => r.grantee === "PUBLIC")).toEqual([]);
    expect(new Set(rows.map((r) => r.routine_name))).toEqual(new Set([
      "carteira_academico_saldo_detalhe",
      "carteira_academico_saldo_ler",
      "carteira_academico_saldo_recalcular",
    ]));
  });

  it("a leitura recusa quem não passa pelo portão", async () => {
    await db.exec("update public.pode set ok = false;");
    await expect(ler()).rejects.toThrow(/Acesso negado/);
  });
});

describe("fechamento da quebra por status", () => {
  beforeEach(async () => {
    // tres alunos, tres situacoes distintas, saldos que somam 1.000,00
    await db.exec(`
      insert into public.alunos values
        ('11111111-1111-1111-1111-111111111111','Formado', '2026-08-04T15:00:00Z'),
        ('22222222-2222-2222-2222-222222222222','Matriculado Curso Normal','2026-08-04T15:00:00Z'),
        ('33333333-3333-3333-3333-333333333333', null, '2026-08-04T15:00:00Z');`);
    await detalhe(`select * from (values
        ('001', '11111111-1111-1111-1111-111111111111'::uuid, 4, 500.00::numeric),
        ('002', '22222222-2222-2222-2222-222222222222'::uuid, 3, 300.00::numeric),
        ('003', '33333333-3333-3333-3333-333333333333'::uuid, 2, 200.00::numeric)
      ) v(cpf, aluno_id, titulos, saldo)`);
    await db.query("select public.carteira_academico_saldo_recalcular('2024')");
  });

  it("as linhas somam exatamente o total da safra", async () => {
    const s = safra(await ler(), "2024");
    expect(s.total).toEqual({ alunos: 3, titulos: 9, saldo: 1000.0 });
    expect(s.linhas.reduce((t, l) => t + l.alunos, 0)).toBe(3);
    expect(s.linhas.reduce((t, l) => t + l.titulos, 0)).toBe(9);
    expect(s.linhas.reduce((t, l) => t + Number(l.saldo), 0)).toBe(1000.0);
  });

  it("o percentual é sobre o saldo DA SAFRA", async () => {
    const s = safra(await ler(), "2024");
    expect(Number(linha(s, "Formado").pct)).toBe(50.0);
    expect(Number(linha(s, "Matriculado Curso Normal").pct)).toBe(30.0);
    expect(s.linhas.reduce((t, l) => t + Number(l.pct), 0)).toBe(100.0);
  });

  it("(sem situação importada) é linha real, com alunos, títulos e saldo", async () => {
    const l = linha(safra(await ler(), "2024"), "(sem situação importada)");
    expect(l).toMatchObject({ alunos: 1, titulos: 2 });
    expect(Number(l.saldo)).toBe(200.0);
    expect(Number(l.pct)).toBe(20.0);
  });

  it("carrega a data da importação acadêmica", async () => {
    const s = safra(await ler(), "2024");
    expect(s.fonte_academica.atualizado_em).toMatch(/^2026-08-04/);
    expect(s.fonte_academica.fonte).toMatch(/importa/i);
  });

  it("não existe total das três safras no payload", async () => {
    const j = await ler();
    expect(Object.keys(j).sort()).toEqual(["lido_em", "safras"]);
    for (const s of j.safras) expect(Object.keys(s)).not.toContain("total_geral");
  });
});

describe("as travas", () => {
  beforeEach(async () => {
    await db.exec(`insert into public.alunos values
      ('11111111-1111-1111-1111-111111111111','Formado','2026-08-04T15:00:00Z');`);
  });

  it("ABORTA quando o universo por título divergir do universo oficial", async () => {
    await universo(9); // oficial diz 9 alunos
    await detalhe(`select * from (values
        ('001','11111111-1111-1111-1111-111111111111'::uuid, 1, 10.00::numeric)
      ) v(cpf, aluno_id, titulos, saldo)`); // detalhe traz 1
    await expect(db.query("select public.carteira_academico_saldo_recalcular('2024')"))
      .rejects.toThrow(/detalhe por titulo tem 1 alunos e carteira_academico_universo tem 9/);
    const { rows } = await db.query("select count(*) n from public.carteira_academico_saldo_snapshot");
    expect(Number(rows[0].n)).toBe(0);
  });

  it("ABORTA quando o recorte devolve zero alunos", async () => {
    await universo(0);
    await detalhe("select null::text, null::uuid, null::integer, null::numeric where false");
    await expect(db.query("select public.carteira_academico_saldo_recalcular('2024')"))
      .rejects.toThrow(/zero alunos/);
  });

  it("a escrita recusa quem não é service_role nem gestão", async () => {
    await db.exec(`
      create or replace function auth.role() returns text language sql stable as $f$ select 'authenticated'::text $f$;
      create or replace function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
      create or replace function public.usuario_e_gestao() returns boolean language sql stable as $f$ select false $f$;`);
    await expect(db.query("select public.carteira_academico_saldo_recalcular('2024')"))
      .rejects.toThrow(/Acesso negado/);
  });
});

describe("nenhuma equivalência entre status", () => {
  it("Matriculado Curso Normal e Aguardando Matrícula ficam em linhas separadas", async () => {
    await universo(2);
    await db.exec(`insert into public.alunos values
      ('11111111-1111-1111-1111-111111111111','Matriculado Curso Normal','2026-08-04T15:00:00Z'),
      ('22222222-2222-2222-2222-222222222222','Aguardando Matrícula','2026-08-04T15:00:00Z');`);
    await detalhe(`select * from (values
        ('001','11111111-1111-1111-1111-111111111111'::uuid, 1, 60.00::numeric),
        ('002','22222222-2222-2222-2222-222222222222'::uuid, 1, 40.00::numeric)
      ) v(cpf, aluno_id, titulos, saldo)`);
    await db.query("select public.carteira_academico_saldo_recalcular('2024')");
    const s = safra(await ler(), "2024");
    expect(s.linhas).toHaveLength(2);
    expect(linha(s, "Matriculado Curso Normal").alunos).toBe(1);
    expect(linha(s, "Aguardando Matrícula").alunos).toBe(1);
  });

  it("a migration não cria agrupamento, equivalência nem 'Outros'", () => {
    const corpo = MIGRACAO.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(corpo).not.toMatch(/'Outros'/);
    expect(corpo).not.toMatch(/\bcase\s+when\s+situacao\b/i);
    // a única normalização permitida é o rótulo do nulo
    expect(corpo.match(/coalesce\(al\.situacao_academica/g)).toHaveLength(1);
  });
});

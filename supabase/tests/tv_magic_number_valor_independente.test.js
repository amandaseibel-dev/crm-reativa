// MAGIC NUMBER COM VALOR PRÓPRIO — comportamento do SNAPSHOT, no banco.
//
// Este arquivo roda as migrations REAIS 20261006152000 e 20261006161500 contra
// um Postgres de verdade (pglite) e confere o payload que sai de
// tv_snapshot_atualizar(). É a prova de que:
//
//   1. o alvo do Magic Number vem de magic_number_mensal, não de meta x 1,5;
//   2. outubro/2026 sai com Meta do Mês 122.400 e Magic Number 142.800 — dois
//      valores independentes no MESMO snapshot, com o MESMO realizado;
//   3. competência sem cadastro devolve magic nulo, e nunca um número derivado;
//   4. tv_snapshot_calcular() não é reescrita: o payload é mesclado;
//   5. o nome "Magic Number" não sobra em lugar nenhum da função de cálculo.
//
// NENHUM DADO REAL — os valores são os combinados pela gestão para out/2026.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Subir uma instância pglite do zero passa dos 5 s padrão do vitest nesta
// máquina, e três casos precisam de banco próprio. Mesmo ajuste dos demais
// testes de banco do repositório.
vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const MIGRATION_TABELA = ler("supabase/migrations/20261006152000_tv_magic_number_valor_independente.sql");
const MIGRATION_NOME = ler("supabase/migrations/20261006161500_tv_nome_magic_number_so_do_valor_proprio.sql");

const GESTAO = "amanda.seibel@aelbra.com.br";

// Competência corrente em São Paulo — a mesma conta que tv_snapshot_atualizar
// faz para escolher a linha de magic_number_mensal.
const COMPETENCIA_AGORA = `
  select to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM') as mes`;

// Andaime mínimo: só o que tv_snapshot_atualizar() toca. tv_snapshot_calcular()
// é stub e devolve um `mes` fixo — o ponto aqui é a MESCLA, não o cálculo.
// A meta piso de 122.400 vem do stub porque, em produção, ela sai de
// metas_projecao.meta_honorario e este teste não a recalcula.
const ANDAIME = `
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
create or replace function auth.email() returns text language sql stable as $$ select auth.jwt()->>'email' $$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(auth.jwt()->>'role', 'authenticated') $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
end $$;

create table if not exists public.tv_snapshot (
  id boolean primary key default true,
  versao bigint not null default 0,
  payload jsonb,
  status text,
  gerado_em timestamptz,
  gerado_por text,
  duracao_ms int,
  erro_resumo text
);
create table if not exists public.tv_config (
  chave text primary key, valor jsonb, ativo boolean default true
);
create table if not exists public.portal_playlist (
  id uuid primary key default gen_random_uuid(), titulo text, artista text,
  adicionado_por text, criado_em timestamptz default now(), ativo boolean default true
);
create table if not exists public.portal_eventos (
  id uuid primary key default gen_random_uuid(), titulo text,
  inicio_em timestamptz, categoria text, ativo boolean default true
);

-- Stub de tv_snapshot_calcular com os MESMOS trechos que o patch ancorado
-- procura, para o teste exercitar a troca de verdade.
create or replace function public._tv_meta_obj(p_id text, p_nome text, p_alvo bigint, p_realizado bigint,
                                               p_tipo text, p_proj bigint, p_du int)
returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_id, 'nome', p_nome, 'alvo', p_alvo, 'realizado', p_realizado) $$;

create or replace function public._tv_meta_hist(p_nome text, p_alvo bigint, p_realizado bigint)
returns jsonb language sql immutable as $$
  select jsonb_build_object('nome', p_nome, 'alvo', p_alvo, 'realizado', p_realizado) $$;

create or replace function public.tv_snapshot_calcular()
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_hon bigint := 70000;        -- honorários do mês (realizado OFICIAL)
  v_hon_ant bigint := 98000;    -- honorários do mês anterior
  v_hon_total bigint := 3400000;
  v_meta_emp bigint := 122400;  -- meta piso: metas_projecao.meta_honorario
  v_proj_hon bigint := 385000;
  v_du_rest int := 18;
  v_metas jsonb;
begin
  select jsonb_agg(m order by ord) into v_metas from (
    select 1 ord, public._tv_meta_obj('empresa','Meta da empresa', v_meta_emp, v_hon, 'mensal', v_proj_hon, v_du_rest) m
    union all select 2, public._tv_meta_obj('magic','Superar o mês passado', coalesce(nullif(v_hon_ant,0),500000), v_hon, 'mensal', v_proj_hon, v_du_rest)
    union all select 3, public._tv_meta_obj('marco','Marco histórico', 3000000, v_hon_total, 'total', v_hon_total, v_du_rest)
  ) z;

  return jsonb_build_object(
    'mes', jsonb_build_object(
      'honorarios', v_hon,
      'meta_empresa', v_meta_emp,
      'meta_pct', round(v_hon::numeric / v_meta_emp * 100, 1),
      'meta_falta', greatest(0, v_meta_emp - v_hon),
      'dias_uteis_mes', 22,
      'dias_uteis_restantes', v_du_rest,
      'proj_honorarios', v_proj_hon),
    'metas', v_metas,
    'julho_historico', jsonb_build_object('ativo', true, 'metas', jsonb_build_array(
      public._tv_meta_hist('Meta da empresa', 450000, v_hon),
      public._tv_meta_hist('Magic Number', 500000, v_hon),
      public._tv_meta_hist('Marco de R$ 3 milhões', 3000000, v_hon_total))));
end;
$function$;
`;

async function novoBanco({ comNome = true } = {}) {
  const db = new PGlite();
  await db.exec(ANDAIME);
  await db.exec(MIGRATION_TABELA);
  if (comNome) await db.exec(MIGRATION_NOME);
  await db.exec(`select set_config('request.jwt.claims', '{"email":"${GESTAO}"}', false)`);
  return db;
}

async function atualizar(db) {
  await db.query("select public.tv_snapshot_atualizar()");
  const r = await db.query("select payload from public.tv_snapshot where id = true");
  return r.rows[0].payload;
}

async function competencia(db) {
  const r = await db.query(COMPETENCIA_AGORA);
  return r.rows[0].mes;
}

let db;
beforeAll(async () => { db = await novoBanco(); });

describe("magic_number_mensal — o campo novo por competência", () => {
  it("existe com uma linha por competência e valor positivo", async () => {
    const r = await db.query(`
      select column_name, data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'magic_number_mensal'
       order by ordinal_position`);
    expect(r.rows.map((c) => c.column_name)).toEqual([
      "mes_referencia", "valor", "observacao", "atualizado_em", "atualizado_por",
    ]);
    const pk = await db.query(`
      select a.attname from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
       where i.indrelid = 'public.magic_number_mensal'::regclass and i.indisprimary`);
    expect(pk.rows.map((x) => x.attname)).toEqual(["mes_referencia"]);
  });

  it("outubro/2026 nasce cadastrado em R$ 142.800,00", async () => {
    const r = await db.query(
      "select valor::text as valor from public.magic_number_mensal where mes_referencia = '2026-10'");
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0].valor)).toBe(142800);
  });

  it("recusa competência malformada e valor não-positivo", async () => {
    await expect(db.query(
      "insert into public.magic_number_mensal(mes_referencia, valor) values ('out/2026', 1000)"
    )).rejects.toThrow();
    await expect(db.query(
      "insert into public.magic_number_mensal(mes_referencia, valor) values ('2026-11', 0)"
    )).rejects.toThrow();
  });

  it("TRUNCATE não fica herdado para quem está logado", async () => {
    const r = await db.query(`
      select has_table_privilege('authenticated', 'public.magic_number_mensal', 'TRUNCATE') as pode`);
    expect(r.rows[0].pode).toBe(false);
  });
});

describe("snapshot — os dois valores de outubro, lado a lado", () => {
  it("Meta do Mês 122.400 e Magic Number 142.800 no MESMO payload", async () => {
    const mes = await competencia(db);
    await db.query(
      `insert into public.magic_number_mensal(mes_referencia, valor) values ($1, 142800)
       on conflict (mes_referencia) do update set valor = excluded.valor`, [mes]);

    const p = await atualizar(db);

    expect(Number(p.mes.meta_empresa)).toBe(122400);   // meta piso
    expect(Number(p.magic.valor)).toBe(142800);        // magic independente
    expect(Number(p.mes.honorarios)).toBe(70000);      // MESMO realizado oficial
    expect(p.magic.mes_referencia).toBe(mes);
  });

  it("o Magic não é múltiplo da meta — nem 1,5 nem nenhum outro fator", async () => {
    const p = await atualizar(db);
    const meta = Number(p.mes.meta_empresa);
    const magic = Number(p.magic.valor);
    expect(magic).not.toBe(Math.round(meta * 1.5));    // 183.600
    expect(magic / meta).toBeCloseTo(1.1666, 3);       // razão de out/2026
  });

  it("o alvo acompanha o cadastro: trocar a linha troca o snapshot", async () => {
    const mes = await competencia(db);
    await db.query(
      "update public.magic_number_mensal set valor = 200000 where mes_referencia = $1", [mes]);
    const p = await atualizar(db);
    expect(Number(p.magic.valor)).toBe(200000);
    expect(Number(p.mes.meta_empresa)).toBe(122400);   // a meta piso não se move
    await db.query(
      "update public.magic_number_mensal set valor = 142800 where mes_referencia = $1", [mes]);
  });

  it("competência sem cadastro devolve magic nulo — nunca derivado da meta", async () => {
    const b = await novoBanco();
    await b.query("delete from public.magic_number_mensal");
    const p = await atualizar(b);
    expect(p.magic).toBeNull();
    expect(Number(p.mes.meta_empresa)).toBe(122400);   // a meta segue lá
    await b.close();
  });
});

describe("o nome \"Magic Number\" só nomeia o valor próprio", () => {
  it("sai do card comemorativo de julho e da chave do comparativo", async () => {
    const p = await atualizar(db);

    const julho = p.julho_historico.metas.map((m) => m.nome);
    expect(julho).not.toContain("Magic Number");
    expect(julho).toContain("Superação de julho");

    const ids = p.metas.map((m) => m.id);
    expect(ids).not.toContain("magic");
    expect(ids).toContain("superar_mes_anterior");
  });

  it("o comparativo continua existindo, com alvo e nome intactos", async () => {
    const p = await atualizar(db);
    const cmp = p.metas.find((m) => m.id === "superar_mes_anterior");
    expect(cmp.nome).toBe("Superar o mês passado");
    expect(Number(cmp.alvo)).toBe(98000);              // honorários do mês anterior
    expect(Number(cmp.realizado)).toBe(70000);         // mesmo realizado oficial
  });

  it("tv_snapshot_calcular fica sem nenhuma ocorrência do nome", async () => {
    const r = await db.query(`
      select pg_get_functiondef(p.oid) as src from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular'`);
    expect(r.rows[0].src).not.toContain("Magic Number");
    expect(r.rows[0].src).not.toContain("* 1.5");
    expect(r.rows[0].src).not.toContain("1.5");
  });

  it("o patch é idempotente: rodar de novo não quebra nem muda nada", async () => {
    const antes = await db.query(`
      select pg_get_functiondef(p.oid) as src from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='tv_snapshot_calcular'`);
    await db.exec(MIGRATION_NOME);
    const depois = await db.query(`
      select pg_get_functiondef(p.oid) as src from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='tv_snapshot_calcular'`);
    expect(depois.rows[0].src).toBe(antes.rows[0].src);
  });

  it("sem a âncora esperada, o patch ABORTA em vez de trocar às cegas", async () => {
    const b = await novoBanco({ comNome: false });
    // Função sem nenhuma das duas âncoras: o bloco não pode "passar batido".
    await b.exec(`
      create or replace function public.tv_snapshot_calcular()
      returns jsonb language sql security definer set search_path to 'public'
      as $f$ select jsonb_build_object('mes', jsonb_build_object('honorarios', 1)) $f$;`);
    await expect(b.exec(MIGRATION_NOME)).rejects.toThrow(/ancora/i);
    await b.close();
  });
});

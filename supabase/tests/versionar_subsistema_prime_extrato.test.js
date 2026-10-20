// VERSIONAR prime_extrato -- COMPORTAMENTO da migration, em PostgreSQL real (PGlite).
//
// O que estes testes travam, na ordem do risco:
//
//   1. a migration NAO SUBSTITUI funcao que ja existe -- e a propriedade que faz dela
//      segura para producao. O teste cria uma funcao com corpo DIFERENTE antes de rodar
//      e exige que o corpo continue o mesmo depois;
//   2. num banco NOVO ela cria as 5 funcoes com o md5 EXATO capturado de producao em
//      20/10/2026 -- se o texto versionado nao reproduz o de producao, o baseline nao
//      vale nada e o teste falha;
//   3. rodar duas vezes e no-op;
//   4. tabelas, indices, RLS, policies e grants nascem como em producao.
//
// NENHUM DADO REAL: as unicas linhas inseridas sao de fila, ficticias.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(AQUI, "..", "..", "supabase/migrations/20261020120000_versionar_subsistema_prime_extrato.sql"),
  "utf8");

// md5(pg_get_functiondef) medidos em producao em 20/10/2026. Estao TAMBEM no cabecalho
// da migration; repetir aqui e proposital -- se alguem mudar um sem o outro, quebra.
const MD5_PRODUCAO = {
  "public.prime_chave_api()": "86eae3185b21c18277ebf6a6174ca0b9",
  "public.prime_extrato_falhou(text,text)": "777f8cd526b0e29c343fdc31e527de1e",
  "public.prime_extrato_mutirao()": "6146ead7b9385fc757a764e92724c08b",
  "public.prime_extrato_ok(text)": "959e534c11cad2e98897f5d4aaf730e3",
  "public.prime_extrato_reenfileirar()": "6d098afc9cccaf2c19f1183c74b16ef2",
};

async function um(db, sql) {
  const r = await db.query(sql);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}
// count() volta como number ou bigint conforme a versao do PGlite; normalizar aqui
// tira a dependencia do tipo sem enfraquecer a asercao.
const n = async (db, sql) => Number(await um(db, sql));

// Bancada minima: so o que a migration precisa para resolver nomes na criacao.
// `auth`, `vault` e `net` NAO sao necessarios -- corpos plpgsql nao sao resolvidos
// na criacao -- mas `usuario_e_gestao` e, porque a POLICY o referencia.
async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create function public.usuario_e_gestao() returns boolean language sql stable as $$ select true $$;
    create table public.prime_contratos (registration text, cpf text, valid_from date);
    create table public.alunos (id uuid default gen_random_uuid(), cpf text);
  `);
  return db;
}

describe("versionar o subsistema prime_extrato", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("NAO SUBSTITUI funcao que ja existe -- a propriedade que a torna segura", async () => {
    // simula producao: a funcao ja existe, com corpo proprio
    await db.exec(`
      create function public.prime_extrato_reenfileirar() returns integer
        language plpgsql security definer set search_path to 'public'
      as $$ begin return 42; end $$;`);
    const antes = await um(db, `select md5(pg_get_functiondef('public.prime_extrato_reenfileirar()'::regprocedure))`);

    await db.exec(MIGRATION);

    const depois = await um(db, `select md5(pg_get_functiondef('public.prime_extrato_reenfileirar()'::regprocedure))`);
    expect(depois).toBe(antes);
    // e o corpo segue sendo o de "producao", nao o versionado
    expect(await um(db, `select public.prime_extrato_reenfileirar()`)).toBe(42);
  });

  it("NAO SUBSTITUI nenhuma das cinco, mesmo com todas pre-existentes e diferentes", async () => {
    await db.exec(`
      create function public.prime_chave_api() returns text language sql as $$ select 'OUTRO' $$;
      create function public.prime_extrato_ok(p text) returns void language sql as $$ select $$;
      create function public.prime_extrato_falhou(a text, b text) returns void language sql as $$ select $$;
      create function public.prime_extrato_reenfileirar() returns integer language sql as $$ select 7 $$;
      create function public.prime_extrato_mutirao() returns bigint language sql as $$ select 9::bigint $$;`);
    const antes = await db.query(`select p.proname, md5(pg_get_functiondef(p.oid)) m
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'prime_%' order by 1`);
    await db.exec(MIGRATION);
    const depois = await db.query(`select p.proname, md5(pg_get_functiondef(p.oid)) m
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'prime_%' order by 1`);
    expect(depois.rows).toEqual(antes.rows);
  });

  it("em banco NOVO cria as cinco com o md5 EXATO de producao", async () => {
    await db.exec(MIGRATION);
    for (const [assinatura, md5] of Object.entries(MD5_PRODUCAO)) {
      const atual = await um(db, `select md5(pg_get_functiondef('${assinatura}'::regprocedure))`);
      expect(atual, assinatura).toBe(md5);
    }
  });

  it("rodar duas vezes e no-op", async () => {
    await db.exec(MIGRATION);
    const antes = await db.query(`select p.proname, md5(pg_get_functiondef(p.oid)) m
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'prime_extrato%' or p.proname='prime_chave_api' order by 1`);
    await db.exec(MIGRATION);
    const depois = await db.query(`select p.proname, md5(pg_get_functiondef(p.oid)) m
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'prime_extrato%' or p.proname='prime_chave_api' order by 1`);
    expect(depois.rows).toEqual(antes.rows);
    expect(await n(db, `select count(*) from pg_policies where tablename like 'prime_extrato%'`)).toBe(2);
  });

  it("as tabelas nascem com as colunas, chaves e indices de producao", async () => {
    await db.exec(MIGRATION);
    expect(await n(db, `select count(*) from information_schema.columns
                         where table_schema='public' and table_name='prime_extrato'`)).toBe(16);
    expect(await n(db, `select count(*) from information_schema.columns
                         where table_schema='public' and table_name='prime_extrato_fila'`)).toBe(7);
    const idx = await db.query(`select indexname from pg_indexes
      where schemaname='public' and tablename='prime_extrato' order by 1`);
    expect(idx.rows.map(r => r.indexname)).toEqual([
      "ix_prime_extrato_boleto", "ix_prime_extrato_boleto_ltrim", "ix_prime_extrato_boleto_mat",
      "ix_prime_extrato_negociacao", "prime_extrato_pkey",
    ]);
    // a chave composta e (matricula, boleto), como em producao
    await db.exec(`insert into public.prime_extrato (matricula, boleto) values ('111','222')`);
    await expect(db.exec(`insert into public.prime_extrato (matricula, boleto) values ('111','222')`))
      .rejects.toThrow(/duplicate key|prime_extrato_pkey/i);
  });

  it("RLS ligada e policy so de leitura para a gestao", async () => {
    await db.exec(MIGRATION);
    for (const t of ["prime_extrato", "prime_extrato_fila"]) {
      expect(await um(db, `select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
                            where n.nspname='public' and c.relname='${t}'`), t).toBe(true);
    }
    const pol = await db.query(`select tablename, policyname, cmd from pg_policies
      where schemaname='public' and tablename like 'prime_extrato%' order by 1`);
    expect(pol.rows.map(r => `${r.tablename}:${r.policyname}:${r.cmd}`)).toEqual([
      "prime_extrato:prime_extrato_gestao:SELECT",
      "prime_extrato_fila:prime_fila_gestao:SELECT",
    ]);
  });

  it("authenticated so le; anon nao le; TRUNCATE nao vai para authenticated", async () => {
    await db.exec(MIGRATION);
    for (const t of ["prime_extrato", "prime_extrato_fila"]) {
      expect(await um(db, `select has_table_privilege('authenticated','public.${t}','SELECT')`), t).toBe(true);
      expect(await um(db, `select has_table_privilege('authenticated','public.${t}','INSERT')`), t).toBe(false);
      expect(await um(db, `select has_table_privilege('authenticated','public.${t}','TRUNCATE')`), t).toBe(false);
      expect(await um(db, `select has_table_privilege('anon','public.${t}','SELECT')`), t).toBe(false);
      expect(await um(db, `select has_table_privilege('service_role','public.${t}','INSERT')`), t).toBe(true);
    }
  });

  it("as funcoes ficam so com service_role -- nenhuma e chamavel pelo front", async () => {
    await db.exec(MIGRATION);
    for (const assinatura of Object.keys(MD5_PRODUCAO)) {
      expect(await um(db, `select has_function_privilege('service_role','${assinatura}','EXECUTE')`), assinatura).toBe(true);
      expect(await um(db, `select has_function_privilege('authenticated','${assinatura}','EXECUTE')`), assinatura).toBe(false);
      expect(await um(db, `select has_function_privilege('anon','${assinatura}','EXECUTE')`), assinatura).toBe(false);
    }
  });

  it("a rotina da fila funciona: enfileira so quem tem aluno na base, e e idempotente", async () => {
    await db.exec(MIGRATION);
    await db.exec(`
      insert into public.prime_contratos values ('2024001','11111111111','2026-01-01');
      insert into public.prime_contratos values ('2024002','22222222222','2026-01-01');
      insert into public.alunos (cpf) values ('111.111.111-11');`);
    expect(await um(db, `select public.prime_extrato_reenfileirar()`)).toBe(1);
    const fila = await db.query(`select matricula, motivo, tentativas from public.prime_extrato_fila`);
    expect(fila.rows).toEqual([{ matricula: "2024001", motivo: "atualizacao semanal", tentativas: 0 }]);
    // rodar de novo nao duplica: a PK e a matricula, e o on conflict reabre a coleta
    await db.exec(`update public.prime_extrato_fila set coletado_em = now(), tentativas = 2`);
    expect(await um(db, `select public.prime_extrato_reenfileirar()`)).toBe(1);
    expect(await n(db, `select count(*) from public.prime_extrato_fila`)).toBe(1);
    expect(await um(db, `select coletado_em from public.prime_extrato_fila`)).toBeNull();
    expect(await um(db, `select tentativas from public.prime_extrato_fila`)).toBe(0);
  });

  it("ok e falhou mexem so na fila, e so na matricula pedida", async () => {
    await db.exec(MIGRATION);
    await db.exec(`insert into public.prime_extrato_fila (matricula) values ('A'),('B')`);
    await db.exec(`select public.prime_extrato_falhou('A','erro de rede')`);
    await db.exec(`select public.prime_extrato_ok('B')`);
    const r = await db.query(`select matricula, tentativas, ultimo_erro, coletado_em is not null coletado
                                from public.prime_extrato_fila order by matricula`);
    expect(r.rows[0]).toMatchObject({ matricula: "A", tentativas: 1, ultimo_erro: "erro de rede", coletado: false });
    expect(r.rows[1]).toMatchObject({ matricula: "B", tentativas: 0, ultimo_erro: null, coletado: true });
  });

  it("a migration nao cria cron nem toca em segredo do Vault", async () => {
    expect(MIGRATION).not.toMatch(/cron\.schedule/i);
    expect(MIGRATION).not.toMatch(/insert\s+into\s+vault/i);
    expect(MIGRATION).not.toMatch(/vault\.create_secret/i);
    // e nao escreve em tabela de negocio
    expect(MIGRATION).not.toMatch(/\b(insert into|update|delete from)\s+public\.(pagamentos|parcelas|acordos|baixas_pagamento|alunos|casos)\b/i);
  });
});

// VERSIONAR prime_extrato -- COMPORTAMENTO da migration, em PostgreSQL real (PGlite).
//
// O que estes testes travam, na ordem do risco:
//
//   1. a migration ABORTA quando o que existe em producao diverge do baseline, ANTES
//      de aplicar qualquer DDL -- um baseline que nao corresponde a producao e pior
//      que nenhum, porque passa a ser citado como se correspondesse;
//   2. objeto PREEXISTENTE nao tem comentario, RLS, policy nem grant tocados -- nem
//      para reafirmar o que ja vale. E a propriedade que torna a migration no-op
//      integral em producao;
//   3. num banco NOVO ela cria as 5 funcoes com o md5 EXATO capturado de producao em
//      20/10/2026 -- se o texto versionado nao reproduz o de producao, o baseline nao
//      vale nada e o teste falha;
//   4. rodar duas vezes e no-op.
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

// Cria as tabelas com a MESMA FORMA do baseline, mas sem comentario, sem RLS, sem
// policy e sem grant -- e assim que elas estao em producao hoje (relacl tem
// authenticated=r, que replicamos, e comentario nenhum).
async function tabelasComoEmProducao(db) {
  await db.exec(`
    create table public.prime_extrato (
      matricula text not null, boleto text not null, cpf text, vencimento date,
      liquidado_em date, valor_liquido numeric, valor_pago numeric, honorario numeric,
      de_acordo boolean, portador integer, portador_nome text,
      coletado_em timestamptz not null default now(), valor_bruto numeric,
      desconto numeric, multa numeric, juros numeric,
      constraint prime_extrato_pkey primary key (matricula, boleto));
    create index ix_prime_extrato_boleto on public.prime_extrato using btree (boleto);
    create index ix_prime_extrato_boleto_ltrim on public.prime_extrato using btree (ltrim(boleto,'0'::text));
    create index ix_prime_extrato_boleto_mat on public.prime_extrato using btree (boleto, matricula);
    create index ix_prime_extrato_negociacao on public.prime_extrato using btree (matricula, portador, liquidado_em)
      where ((portador = 195) and (liquidado_em is not null));
    create table public.prime_extrato_fila (
      matricula text not null, cpf text, motivo text, tentativas integer not null default 0,
      ultimo_erro text, coletado_em timestamptz, criado_em timestamptz not null default now(),
      constraint prime_extrato_fila_pkey primary key (matricula));
    grant select on table public.prime_extrato to authenticated;
    grant select on table public.prime_extrato_fila to authenticated;
  `);
}

describe("versionar o subsistema prime_extrato", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  // ---- 1. aborta quando diverge -------------------------------------------
  it("ABORTA quando uma funcao existente diverge do baseline", async () => {
    await db.exec(`
      create function public.prime_extrato_reenfileirar() returns integer
        language plpgsql security definer set search_path to 'public'
      as $$ begin return 42; end $$;`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/BASELINE INCOMPATIVEL/i);
  });

  it("a mensagem do aborto diz QUAL objeto divergiu e os dois md5", async () => {
    await db.exec(`
      create function public.prime_chave_api() returns text language sql as $$ select 'OUTRO' $$;`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/prime_chave_api\(\).*86eae3185b21c18277ebf6a6174ca0b9/s);
  });

  it("ABORTA quando uma tabela existente tem forma diferente", async () => {
    await db.exec(`create table public.prime_extrato (matricula text, boleto text)`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/prime_extrato: producao tem 2 colunas/i);
  });

  it("quando aborta, NADA e aplicado", async () => {
    await db.exec(`
      create function public.prime_extrato_ok(p text) returns void language sql as $$ select $$;`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/BASELINE INCOMPATIVEL/i);
    // o `begin` da migration fica aberto e abortado apos a excecao; encerrar a
    // transacao e o que um cliente real faz, e e o proprio rollback que prova
    // que nada do PASSO 3 em diante chegou a existir.
    await db.exec("rollback").catch(() => {});
    // nenhuma tabela e nenhuma das outras funcoes foi criada
    expect(await um(db, `select to_regclass('public.prime_extrato') is null`)).toBe(true);
    expect(await um(db, `select to_regprocedure('public.prime_chave_api()') is null`)).toBe(true);
    // e a funcao que existia continua a mesma
    expect(await um(db, `select prosrc from pg_proc where proname='prime_extrato_ok'`)).toBe(" select ");
  });

  // ---- 2. nao toca em objeto preexistente ---------------------------------
  it("tabela PREEXISTENTE nao recebe comentario, RLS nem policy", async () => {
    await tabelasComoEmProducao(db);
    await db.exec(MIGRATION);
    for (const t of ["prime_extrato", "prime_extrato_fila"]) {
      expect(await um(db, `select obj_description('public.${t}'::regclass,'pg_class')`), t).toBeNull();
      expect(await um(db, `select relrowsecurity from pg_class c join pg_namespace nn on nn.oid=c.relnamespace
                            where nn.nspname='public' and c.relname='${t}'`), t).toBe(false);
    }
    expect(await n(db, `select count(*) from pg_policies where tablename like 'prime_extrato%'`)).toBe(0);
  });

  it("tabela PREEXISTENTE nao tem o ACL alterado", async () => {
    await tabelasComoEmProducao(db);
    const antes = await db.query(`select c.relname, c.relacl::text from pg_class c
      join pg_namespace nn on nn.oid=c.relnamespace
      where nn.nspname='public' and c.relname like 'prime_extrato%' order by 1`);
    await db.exec(MIGRATION);
    const depois = await db.query(`select c.relname, c.relacl::text from pg_class c
      join pg_namespace nn on nn.oid=c.relnamespace
      where nn.nspname='public' and c.relname like 'prime_extrato%' order by 1`);
    expect(depois.rows).toEqual(antes.rows);
  });

  it("com as tabelas preexistentes, a migration ainda cria as funcoes que faltam", async () => {
    await tabelasComoEmProducao(db);
    await db.exec(MIGRATION);
    for (const [assinatura, md5] of Object.entries(MD5_PRODUCAO)) {
      expect(await um(db, `select md5(pg_get_functiondef('${assinatura}'::regprocedure))`), assinatura).toBe(md5);
    }
  });

  // ---- 3. banco novo -------------------------------------------------------
  it("em banco NOVO cria as cinco com o md5 EXATO de producao", async () => {
    await db.exec(MIGRATION);
    for (const [assinatura, md5] of Object.entries(MD5_PRODUCAO)) {
      expect(await um(db, `select md5(pg_get_functiondef('${assinatura}'::regprocedure))`), assinatura).toBe(md5);
    }
  });

  it("em banco NOVO as tabelas nascem com colunas, PK e os 5 indices", async () => {
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
    await db.exec(`insert into public.prime_extrato (matricula, boleto) values ('111','222')`);
    await expect(db.exec(`insert into public.prime_extrato (matricula, boleto) values ('111','222')`))
      .rejects.toThrow(/duplicate key|prime_extrato_pkey/i);
  });

  it("em banco NOVO: RLS ligada, policy so de leitura para a gestao", async () => {
    await db.exec(MIGRATION);
    for (const t of ["prime_extrato", "prime_extrato_fila"]) {
      expect(await um(db, `select relrowsecurity from pg_class c join pg_namespace nn on nn.oid=c.relnamespace
                            where nn.nspname='public' and c.relname='${t}'`), t).toBe(true);
    }
    const pol = await db.query(`select tablename, policyname, cmd from pg_policies
      where schemaname='public' and tablename like 'prime_extrato%' order by 1`);
    expect(pol.rows.map(r => `${r.tablename}:${r.policyname}:${r.cmd}`)).toEqual([
      "prime_extrato:prime_extrato_gestao:SELECT",
      "prime_extrato_fila:prime_fila_gestao:SELECT",
    ]);
  });

  it("em banco NOVO: authenticated so le; anon nao le; TRUNCATE nao vai para authenticated", async () => {
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

  // ---- 4. idempotencia -----------------------------------------------------
  it("rodar duas vezes e no-op, inclusive no ACL e no comentario", async () => {
    await db.exec(MIGRATION);
    const antes = await db.query(`
      select c.relname obj, c.relacl::text acl, c.relrowsecurity rls,
             obj_description(c.oid,'pg_class') com
        from pg_class c join pg_namespace nn on nn.oid=c.relnamespace
       where nn.nspname='public' and c.relname like 'prime_extrato%' order by 1`);
    const fAntes = await db.query(`select p.proname, md5(pg_get_functiondef(p.oid)) m, p.proacl::text
      from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace
      where nn.nspname='public' and (p.proname like 'prime_extrato%' or p.proname='prime_chave_api') order by 1`);

    await db.exec(MIGRATION);

    const depois = await db.query(`
      select c.relname obj, c.relacl::text acl, c.relrowsecurity rls,
             obj_description(c.oid,'pg_class') com
        from pg_class c join pg_namespace nn on nn.oid=c.relnamespace
       where nn.nspname='public' and c.relname like 'prime_extrato%' order by 1`);
    const fDepois = await db.query(`select p.proname, md5(pg_get_functiondef(p.oid)) m, p.proacl::text
      from pg_proc p join pg_namespace nn on nn.oid=p.pronamespace
      where nn.nspname='public' and (p.proname like 'prime_extrato%' or p.proname='prime_chave_api') order by 1`);

    expect(depois.rows).toEqual(antes.rows);
    expect(fDepois.rows).toEqual(fAntes.rows);
    expect(await n(db, `select count(*) from pg_policies where tablename like 'prime_extrato%'`)).toBe(2);
  });

  // ---- comportamento das funcoes ------------------------------------------
  it("a rotina da fila funciona: enfileira so quem tem aluno na base, e e idempotente", async () => {
    await db.exec(MIGRATION);
    await db.exec(`
      insert into public.prime_contratos values ('2024001','11111111111','2026-01-01');
      insert into public.prime_contratos values ('2024002','22222222222','2026-01-01');
      insert into public.alunos (cpf) values ('111.111.111-11');`);
    expect(await um(db, `select public.prime_extrato_reenfileirar()`)).toBe(1);
    const fila = await db.query(`select matricula, motivo, tentativas from public.prime_extrato_fila`);
    expect(fila.rows).toEqual([{ matricula: "2024001", motivo: "atualizacao semanal", tentativas: 0 }]);
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

  // ---- o que a migration nao pode conter ----------------------------------
  it("a migration nao cria cron, nao toca no Vault e nao escreve em tabela de negocio", async () => {
    expect(MIGRATION).not.toMatch(/cron\.schedule/i);
    expect(MIGRATION).not.toMatch(/insert\s+into\s+vault/i);
    expect(MIGRATION).not.toMatch(/vault\.create_secret/i);
    expect(MIGRATION).not.toMatch(/\b(insert into|update|delete from)\s+public\.(pagamentos|parcelas|acordos|baixas_pagamento|alunos|casos)\b/i);
  });

  it("nenhum COMMENT, GRANT, REVOKE, ALTER ou POLICY fora de bloco condicional", async () => {
    // tira comentarios de linha e o corpo dos blocos DO (que ja sao condicionais)
    const semComentario = MIGRATION.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
    const foraDeDo = semComentario.replace(/do \$\$[\s\S]*?\$\$;/g, "");
    for (const proibido of [/comment\s+on/i, /\bgrant\b/i, /\brevoke\b/i, /alter\s+table/i, /create\s+policy/i]) {
      expect(foraDeDo, String(proibido)).not.toMatch(proibido);
    }
  });
});

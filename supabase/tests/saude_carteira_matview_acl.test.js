// A MATVIEW DA SAUDE DA CARTEIRA NAO PODE SER LEGIVEL POR `authenticated`.
//
// O QUE ACONTECEU (producao, 02/10/2026).
//
// A migration 20261002120000 recria `mv_saude_carteira` -- `create or replace`
// nao adiciona coluna a materialized view. O schema `public` tem um
// ALTER DEFAULT PRIVILEGES que concede TUDO a `authenticated` em relacoes
// novas. A matview antiga nao tinha esse grant; a recriada herdou. Medido logo
// apos a aplicacao: a ACL voltou como
//   postgres | authenticated | service_role
// em vez de
//   postgres | service_role
//
// POR QUE ISSO IMPORTA. A tela le a carteira pelas RPCs SECURITY DEFINER, que
// aplicam `saude_carteira_escopo`: operador enxerga so a propria carteira. Com
// SELECT direto na matview, qualquer usuario autenticado le a carteira INTEIRA,
// de todos os operadores -- o escopo deixa de existir.
//
// A CORRECAO E UMA VERSAO PROPRIA, nao uma linha dentro da 20261002120000:
// aquela versao JA FOI APLICADA em producao, e editar o arquivo de uma versao
// aplicada quebra a correspondencia entre repositorio e banco. Este arquivo
// tambem prende isso (ver "o ledger fica intacto").
//
// Nao testa calculo, view, RPC nem regra de cobertura: nada disso muda aqui.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const APLICADA = "supabase/migrations/20261002120000_saude_carteira_cobertura_10d.sql";
const APLICADA_RB = "supabase/rollbacks/20261002120000_saude_carteira_cobertura_10d.rollback.sql";
const MIGRATION = "supabase/migrations/20261002121000_mv_saude_carteira_acl_sem_authenticated.sql";
const ROLLBACK = "supabase/rollbacks/20261002121000_mv_saude_carteira_acl_sem_authenticated.rollback.sql";
const REVOKE = "revoke all on public.mv_saude_carteira from authenticated;";

const ler = (p) => readFileSync(p, "utf-8");

// Reproduz a situacao de producao: o papel `authenticated` e contemplado por um
// default privilege em `public`. E exatamente isso que faz um objeto novo nascer
// legivel sem ninguem ter escrito um grant.
async function bancoComoProducao() {
  const db = await PGlite.create();
  await db.exec(`
    create role authenticated;
    create role service_role;
    alter default privileges in schema public
      grant all on tables to authenticated, service_role;
  `);
  return db;
}

// Uma matview qualquer serve: o que esta sob teste e a ACL de uma matview
// RECEM-CRIADA em public, nao o conteudo da Saude da Carteira.
const CRIA_BASE = `
  create table base (id int primary key, v int);
  insert into base values (1, 10);
`;

// Criar a matview e um passo proprio porque o rollback da cobertura faz isso DE
// NOVO: a tabela de apoio sobrevive, a matview nao.
const CRIA_MATVIEW = `
  create materialized view public.mv_saude_carteira as select * from base;
  create unique index ux_mv on public.mv_saude_carteira (id);
  grant select on public.mv_saude_carteira to service_role;
`;

const podeLer = async (db, papel) =>
  (await db.query(`select has_table_privilege($1, 'public.mv_saude_carteira', 'SELECT') ok`, [papel]))
    .rows[0].ok;

const acl = async (db) =>
  (await db.query(`
    select coalesce(array_to_string(c.relacl, ' | '), '(sem acl)') acl
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'mv_saude_carteira'`)).rows[0].acl;

describe("ACL da matview da Saúde da Carteira", () => {
  it("o default privilege concede: sem o revoke, a matview recriada já nasce legível por authenticated", async () => {
    const db = await bancoComoProducao();
    await db.exec(CRIA_BASE);
    await db.exec(CRIA_MATVIEW);

    // Ninguem escreveu `grant ... to authenticated`. O default privilege fez.
    expect(await podeLer(db, "authenticated")).toBe(true);
    expect(await acl(db)).toContain("authenticated");
    await db.close();
  });

  it("a migration nova remove: authenticated deixa de ter privilégio direto", async () => {
    const db = await bancoComoProducao();
    await db.exec(CRIA_BASE);
    await db.exec(CRIA_MATVIEW);
    await db.exec(ler(MIGRATION));

    expect(await podeLer(db, "authenticated")).toBe(false);
    expect(await acl(db)).not.toContain("authenticated=");
    await db.close();
  });

  it("service_role continua acessando — as RPCs SECURITY DEFINER dependem disso", async () => {
    const db = await bancoComoProducao();
    await db.exec(CRIA_BASE);
    await db.exec(CRIA_MATVIEW);
    await db.exec(ler(MIGRATION));

    expect(await podeLer(db, "service_role")).toBe(true);
    expect(await acl(db)).toContain("service_role");
    await db.close();
  });

  it("o rollback desta migration não reabre o buraco, e acusa se alguém reabriu", async () => {
    const db = await bancoComoProducao();
    await db.exec(CRIA_BASE);
    await db.exec(CRIA_MATVIEW);
    await db.exec(ler(MIGRATION));

    // estado seguro: o rollback passa e nao muda nada
    await db.exec(ler(ROLLBACK));
    expect(await podeLer(db, "authenticated")).toBe(false);
    expect(await podeLer(db, "service_role")).toBe(true);

    // estado inseguro: alguem reconcedeu por fora -> o rollback falha alto
    await db.exec(`grant select on public.mv_saude_carteira to authenticated;`);
    await expect(db.exec(ler(ROLLBACK))).rejects.toThrow(/legivel por authenticated/);
    await db.close();
  });

  it("o rollback da COBERTURA reabre o buraco — por isso a migration nova tem de ser reaplicada depois dele", async () => {
    const db = await bancoComoProducao();
    await db.exec(CRIA_BASE);
    await db.exec(CRIA_MATVIEW);
    await db.exec(ler(MIGRATION));
    expect(await podeLer(db, "authenticated")).toBe(false);

    // o rollback da 20261002120000 derruba e recria a matview
    await db.exec(`drop materialized view public.mv_saude_carteira;`);
    await db.exec(CRIA_MATVIEW);
    expect(await podeLer(db, "authenticated")).toBe(true); // o grant voltou

    // reaplicar a migration nova fecha de novo
    await db.exec(ler(MIGRATION));
    expect(await podeLer(db, "authenticated")).toBe(false);
    await db.close();
  });

  // Os testes acima provam o MECANISMO. Estes amarram o mecanismo aos arquivos
  // reais: sem isso, alguem removeria a linha e os testes de cima seguiriam
  // verdes, porque eles executariam outro texto.
  it("a migration nova contém exatamente o revoke, e nada mais", async () => {
    const sql = ler(MIGRATION);
    expect(sql).toContain(REVOKE);
    // nenhum comando alem do revoke: so comentarios e a linha
    const comandos = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--") && l.trim() !== "")
      .join(" ")
      .trim();
    expect(comandos).toBe(REVOKE);
  });

  it("o ledger fica intacto: a versão JÁ APLICADA não foi editada", async () => {
    // A 20261002120000 esta em producao. O revoke NAO pode ter sido injetado
    // nela nem no rollback dela -- a correcao e versao propria.
    for (const p of [APLICADA, APLICADA_RB]) {
      expect(ler(p)).not.toContain(REVOKE);
    }
  });

  it("nenhum dos arquivos desta correção concede algo a authenticated", async () => {
    for (const p of [MIGRATION, ROLLBACK]) {
      expect(ler(p)).not.toMatch(/^\s*grant[^;]*\bto\b[^;]*authenticated/im);
    }
  });
});

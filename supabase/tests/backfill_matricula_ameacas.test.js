// MODELO DE AMEACA: o que consegue quem tiver a credencial `service_role`.
//
// A DECLARACAO QUE ESTE ARQUIVO PROVA, e que tambem esta escrita na
// 20260915170000:
//
//   A Edge protege o endpoint publico. A RPC considera posse da credencial
//   `service_role` uma credencial administrativa de carga, mas essa credencial
//   NAO possui autoridade para aplicar o lote. A integridade financeira
//   permanece protegida pelo motor postgres-only, pelo hash do artefato e
//   pelos invariantes.
//
// Conceder EXECUTE na RPC a `service_role` significa que quem tiver essa
// credencial chama a carga direto, sem token nem HMAC da Edge. Isto NAO e um
// descuido: e uma decisao, e o que a torna aceitavel e o teto do dano. Este
// arquivo mede esse teto.
//
// PGLITE E POSTGRES DE VERDADE E NAO SUBSTITUI O SUPABASE: aqui nao ha
// PostgREST nem os papeis reais com suas herancas. O que se prova e a
// autoridade dos papeis dentro do banco -- e essa parte e a mesma.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGS = resolve(AQUI, "..", "migrations");
const ler = (f) => readFileSync(resolve(MIGS, f), "utf8");
const sqlPrep = ler("20260915135959_prepara_acl_da_stage_do_backfill.sql");
const sqlMotor = ler("20260915140000_backfill_matricula_prime_motor.sql");
const sqlRpc = ler("20260915170000_rpc_de_carga_da_stage_backfill.sql");

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BOL = (n) => String(590000000000 + n);
const MAT = (n) => String(900000000 + n);
const reg = (n, over = {}) => ({
  pagamento_id: U(n), numero_parcela_completo: BOL(n), matricula: MAT(n),
  arquivo_origem: "sintetico.xlsx", linha_no_arquivo: n, ...over });
const canonizar = (p) => p.map((r) => [r.pagamento_id, r.numero_parcela_completo,
  r.matricula, r.arquivo_origem, r.linha_no_arquivo].join("|")).sort().join("\n");
const md5 = (s) => createHash("md5").update(s).digest("hex");

const PLANO = [1, 2, 3].map((n) => reg(n));
const HASH_LEGITIMO = md5(canonizar(PLANO));

async function bancada() {
  const db = await PGlite.create();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.pagamentos (id uuid primary key, numero_parcela_completo text,
      matricula text, tipo_pagamento text);`);
  // reproduz producao: os tres papeis tem USAGE mas NAO CREATE em public
  await db.exec(`
    revoke create on schema public from public, anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
  await db.exec(sqlPrep); await db.exec(sqlMotor); await db.exec(sqlRpc);
  for (const n of [1, 2, 3])
    await db.query(`insert into public.pagamentos values ($1,$2,null,'SANTANDER')`, [U(n), BOL(n)]);

  /** executa algo COMO service_role -- o que o PostgREST faz com SET LOCAL ROLE */
  db.comoServiceRole = async (sql, args = []) => {
    try {
      await db.exec(`set role service_role;`);
      const r = await db.query(sql, args);
      return { ok: true, linhas: r.rows };
    } catch (e) { return { ok: false, erro: e.message }; }
    finally { await db.exec(`reset role;`); }
  };
  db.carregar = (lote, registros) => db.comoServiceRole(
    `select public.backfill_matricula_stage_carregar($1,$2::jsonb) r`,
    [lote, JSON.stringify(registros)]);
  db.aplicarComoDono = async (lote, hash, esperado) => {
    try {
      const r = await db.query(`select public.backfill_matricula_aplicar($1,$2,$3) r`,
        [lote, hash, esperado]);
      return { ok: true, valor: r.rows[0].r };
    } catch (e) { return { ok: false, erro: e.message }; }
  };
  db.conta = async (t, onde = "true") => Number(
    (await db.query(`select count(*) c from public.${t} where ${onde}`)).rows[0].c);
  db.fotoPagamentos = async () => (await db.query(
    `select coalesce(md5(string_agg(id::text||'|'||coalesce(matricula,''),',' order by id::text)),'')
       h from public.pagamentos`)).rows[0].h;
  return db;
}

describe("8. PORTAO: nenhum papel de aplicacao cria objeto em public", () => {
  let db;
  beforeAll(async () => { db = await bancada(); }, 60000);
  it.each(["service_role", "anon", "authenticated", "public"])(
    "%s NAO tem CREATE em public", async (papel) => {
      const r = await db.query(`select has_schema_privilege($1,'public','CREATE') x`, [papel]);
      // Se isto virar true, a analise do SECURITY DEFINER/search_path muda:
      // o papel poderia plantar um objeto em `public` e sequestrar referencia.
      expect(r.rows[0].x, `${papel} ganhou CREATE em public`).toBe(false);
    });
  it("service_role nao e superusuario", async () => {
    const r = await db.query(`select rolsuper from pg_roles where rolname='service_role'`);
    expect(r.rows[0].rolsuper).toBe(false);
  });
});

describe("1. o teto: como service_role, so da para inserir na stage", () => {
  let db;
  beforeAll(async () => { db = await bancada(); }, 60000);

  it("consegue carregar pela RPC", async () => {
    const r = await db.carregar("LOTE_LEGITIMO", PLANO);
    expect(r.ok, r.erro).toBe(true);
    expect(await db.conta("backfill_matricula_stage", `lote='LOTE_LEGITIMO'`)).toBe(3);
  });
  it("e SO isso: nao le a stage nem depois de ter escrito nela", async () => {
    const r = await db.comoServiceRole(`select * from public.backfill_matricula_stage`);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/permission denied|permissão negada/i);
  });
});

describe("2. NAO consegue executar o motor", () => {
  let db;
  beforeAll(async () => { db = await bancada(); }, 60000);
  it("chamada direta ao motor e negada no privilegio", async () => {
    const r = await db.comoServiceRole(
      `select public.backfill_matricula_aplicar('LOTE_LEGITIMO',$1,3)`, [HASH_LEGITIMO]);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/permission denied|permissão negada/i);
  });
  it("e mesmo que o privilegio existisse, o gate do motor barraria", async () => {
    // concedo EXECUTE de proposito para provar a SEGUNDA camada
    await db.exec(`grant execute on function
      public.backfill_matricula_aplicar(text, text, integer) to service_role;`);
    const r = await db.comoServiceRole(
      `select public.backfill_matricula_aplicar('LOTE_LEGITIMO',$1,3)`, [HASH_LEGITIMO]);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/exclusiva do dono \(postgres\)/);
    await db.exec(`revoke execute on function
      public.backfill_matricula_aplicar(text, text, integer) from service_role;`);
  });
});

describe("3 e 4. NAO consegue ler, alterar nem apagar nada", () => {
  let db;
  beforeAll(async () => { db = await bancada(); await db.carregar("L", PLANO); }, 60000);

  const negado = async (rotulo, sql, args = []) => {
    const r = await db.comoServiceRole(sql, args);
    expect(r.ok, `${rotulo} NAO foi negado`).toBe(false);
    expect(r.erro).toMatch(/permission denied|permissão negada/i);
  };
  it("SELECT na stage", () => negado("select stage", `select * from public.backfill_matricula_stage`));
  it("UPDATE na stage", () => negado("update stage",
    `update public.backfill_matricula_stage set matricula='0'`));
  it("DELETE na stage", () => negado("delete stage",
    `delete from public.backfill_matricula_stage`));
  it("INSERT direto na stage", () => negado("insert stage",
    `insert into public.backfill_matricula_stage values ('X',$1,'1','1','a',1)`, [U(9)]));
  it("UPDATE em pagamentos", () => negado("update pagamentos",
    `update public.pagamentos set matricula='999'`));
  it("DELETE em pagamentos", () => negado("delete pagamentos",
    `delete from public.pagamentos`));
  it("INSERT em backfill_matricula_lotes", () => negado("insert lotes",
    `insert into public.backfill_matricula_lotes (lote,artefato_hash,quantidade_esperada,status)
     values ('FALSO','x',1,'APLICADO')`));
  it("INSERT em backfill_matricula_origem", () => negado("insert origem",
    `insert into public.backfill_matricula_origem
       (lote,pagamento_id,numero_parcela_completo,matricula,arquivo_origem,linha_no_arquivo)
     values ('FALSO',$1,'1','1','a',1)`, [U(1)]));
  it("SELECT em backfill_matricula_origem", () => negado("select origem",
    `select * from public.backfill_matricula_origem`));
});

describe("5. AMEACA: adulterar uma linha da stage", () => {
  let db, r;
  beforeAll(async () => {
    db = await bancada();
    // o atacante carrega o lote com UMA matricula trocada
    const adulterado = PLANO.map((x, i) => (i === 1 ? { ...x, matricula: "111111111" } : x));
    await db.carregar("LOTE_LEGITIMO", adulterado);
    // gatilho-sentinela: se o UPDATE for alcancado, o erro sera OUTRO
    await db.exec(`
      create function sentinela() returns trigger language plpgsql as $$
        begin raise exception 'UPDATE ALCANCADO'; end $$;
      create trigger tg_sentinela before update on public.pagamentos
        for each row execute function sentinela();`);
    // o dono aplica com o hash do artefato LEGITIMO
    r = await db.aplicarComoDono("LOTE_LEGITIMO", HASH_LEGITIMO, 3);
  }, 60000);

  it("a aplicacao aborta", () => expect(r.ok).toBe(false));
  it("aborta NO HASH, e nao em outro lugar", () =>
    expect(r.erro).toMatch(/nao confere com o artefato auditado/));
  it("ABORTA ANTES DE QUALQUER UPDATE -- a sentinela nunca disparou", () =>
    expect(r.erro).not.toMatch(/UPDATE ALCANCADO/));
  it("nenhuma matricula foi gravada", async () => {
    expect(await db.conta("pagamentos", "matricula is not null")).toBe(0);
  });
  it("nenhum lote e nenhuma trilha foram criados", async () => {
    expect(await db.conta("backfill_matricula_lotes")).toBe(0);
    expect(await db.conta("backfill_matricula_origem")).toBe(0);
  });
});

describe("6. AMEACA: envenenar o lote antes da carga legitima", () => {
  let db, foto;
  beforeAll(async () => {
    db = await bancada();
    // o atacante ocupa ANTES duas das tres posicoes, com conteudo errado
    await db.carregar("LOTE_LEGITIMO", [
      reg(1, { matricula: "111111111" }),
      reg(2, { arquivo_origem: "FALSO.xlsx" }),
    ]);
    foto = await db.fotoPagamentos();
  }, 60000);

  it("a carga legitima NAO sobrescreve o que o atacante deixou", async () => {
    const r = await db.carregar("LOTE_LEGITIMO", PLANO);
    expect(r.ok, r.erro).toBe(true);           // DO NOTHING: nao falha, nao altera
    const v = await db.query(
      `select matricula from public.backfill_matricula_stage
        where lote='LOTE_LEGITIMO' and pagamento_id=$1`, [U(1)]);
    expect(v.rows[0].matricula).toBe("111111111");   // continua o do atacante
  });
  it("e por isso o hash final diverge", async () => {
    const v = await db.query(
      `select md5(string_agg(pagamento_id::text||'|'||numero_parcela_completo||'|'||
              matricula||'|'||arquivo_origem||'|'||linha_no_arquivo::text,
              E'\n' order by pagamento_id::text collate "C")) h
         from public.backfill_matricula_stage where lote='LOTE_LEGITIMO'`);
    expect(v.rows[0].h).not.toBe(HASH_LEGITIMO);
  });
  it("a aplicacao com o artefato legitimo aborta", async () => {
    const r = await db.aplicarComoDono("LOTE_LEGITIMO", HASH_LEGITIMO, 3);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/nao confere com o artefato auditado/);
  });
  it("e nada financeiro se moveu", async () => {
    expect(await db.fotoPagamentos()).toBe(foto);
    expect(await db.conta("backfill_matricula_lotes")).toBe(0);
  });
  it("o dano maximo e NEGAR a carga -- reversivel apagando o lote como dono", async () => {
    await db.query(`delete from public.backfill_matricula_stage where lote='LOTE_LEGITIMO'`);
    await db.carregar("LOTE_LEGITIMO", PLANO);
    const r = await db.aplicarComoDono("LOTE_LEGITIMO", HASH_LEGITIMO, 3);
    expect(r.ok, r.erro).toBe(true);
    expect(r.valor.alteracoes).toBe(3);
  });
});

describe("7. AMEACA: inventar um lote proprio e tentar aplica-lo", () => {
  let db;
  beforeAll(async () => { db = await bancada(); }, 60000);

  it("service_role cria o lote na stage sem problema", async () => {
    const r = await db.carregar("LOTE_DO_ATACANTE", [reg(1, { matricula: "666666666" })]);
    expect(r.ok, r.erro).toBe(true);
  });
  it("mas NAO consegue aplica-lo -- sem EXECUTE no motor", async () => {
    const proprioHash = md5(canonizar([reg(1, { matricula: "666666666" })]));
    const r = await db.comoServiceRole(
      `select public.backfill_matricula_aplicar('LOTE_DO_ATACANTE',$1,1)`, [proprioHash]);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/permission denied|permissão negada/i);
  });
  it("nem com EXECUTE concedido -- o gate exige ser o dono", async () => {
    await db.exec(`grant execute on function
      public.backfill_matricula_aplicar(text, text, integer) to service_role;`);
    const proprioHash = md5(canonizar([reg(1, { matricula: "666666666" })]));
    const r = await db.comoServiceRole(
      `select public.backfill_matricula_aplicar('LOTE_DO_ATACANTE',$1,1)`, [proprioHash]);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/exclusiva do dono \(postgres\)/);
    await db.exec(`revoke execute on function
      public.backfill_matricula_aplicar(text, text, integer) from service_role;`);
  });
  it("nada financeiro se moveu, e nenhuma trilha nasceu", async () => {
    expect(await db.conta("pagamentos", "matricula is not null")).toBe(0);
    expect(await db.conta("backfill_matricula_lotes")).toBe(0);
    expect(await db.conta("backfill_matricula_origem")).toBe(0);
  });
});

describe("a declaracao esta escrita na migration, nao so aqui", () => {
  it("a 20260915170000 declara o limite da credencial", () => {
    expect(sqlRpc).toMatch(/credencial administrativa de carga/);
    expect(sqlRpc).toMatch(/NAO possui autoridade para aplicar o lote/);
    expect(sqlRpc).toMatch(/motor postgres-only/);
  });
  it("e registra a dependencia do CREATE em public", () => {
    expect(sqlRpc).toMatch(/has_schema_privilege\('service_role','public','CREATE'\)/);
  });
});

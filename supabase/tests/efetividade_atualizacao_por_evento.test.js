// A POLÍTICA DE ATUALIZAÇÃO da fotografia, em PostgreSQL real.
//
// A camada de desempenho resolveu o teto de 8 s mas trocou "a tela cai" por "a
// tela mostra número velho". O que este teste prova:
//
//  - MARCAR é de STATEMENT, não de linha. Um lote de mil linhas marca UMA vez.
//    Gatilho por linha em tabela quente já derrubou o banco em 24/09/2026;
//  - a marca guarda a PRIMEIRA mudança do ciclo, não a última — senão ela
//    rejuvenesceria durante um lote e a reconstrução nunca alcançaria o fim;
//  - o que o BOTÃO chama (`pedir_atualizacao`) só marca: não reconstrói nada,
//    porque reconstruir dentro da requisição é pedir para ser cortado nos 8 s;
//  - o atendedor respeita o piso de 4 minutos e o lock, para não virar moedor;
//  - o recálculo LIMPA a marca ao gravar, e só ao gravar: se abortar, a marca
//    fica e o próximo ciclo tenta de novo;
//  - a leitura diz `desatualizada`, para a tela nunca apresentar fotografia
//    antiga como dado ao vivo;
//  - a rede de segurança roda de 20 em 20 minutos, igual ao atendedor de 5;
//  - nenhuma regra financeira neste arquivo.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIG = (n) => readFileSync(resolve(AQUI, "..", "migrations", `${n}.sql`), "utf8");
const CAMADA = MIG("20261007210000_efetividade_camada_de_desempenho");
const POLITICA = MIG("20261007230000_efetividade_atualizacao_por_evento");

// a camada sem a primeira fotografia (depende das funções oficiais de produção)
const CAMADA_SEM_FOTO = CAMADA.slice(0, CAMADA.indexOf("-- --------------------------------------------------- 4."));

const TOTAL = { alunos: 30, titulos: 120, valor: 4000.0 };
const SIT = JSON.stringify({
  recorte: "2024",
  situacoes: { entrou: { valor: 10000.0 }, em_aberto: TOTAL },
});
const ACA = JSON.stringify({ recorte: "2024", total: TOTAL, linhas: [] });
const PEN = JSON.stringify({ recorte: "2024", motivos: [] });

let db;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
    end $$;
    create schema if not exists auth;
    create schema if not exists cron;
    create table cron.job (jobname text, schedule text);
    create function cron.schedule(a text, b text, c text) returns bigint language sql as $f$
      insert into cron.job values (a, b) returning 1::bigint $f$;
    create function auth.role() returns text language sql stable as $f$ select 'service_role'::text $f$;
    create function auth.jwt() returns jsonb language sql stable as $f$ select null::jsonb $f$;
    create function public.usuario_e_gestao() returns boolean language sql stable as $f$ select true $f$;
    create table public.pode (ok boolean); insert into public.pode values (true);
    create function public.carteira_2026_1_pode_ler() returns boolean language sql stable
      as $f$ select coalesce((select ok from public.pode limit 1), false) $f$;
    -- as tabelas que o gatilho observa, vazias: o gatilho é de statement e não
    -- olha linha nenhuma
    create table public.pagamentos (id serial primary key, valor numeric);
    create table public.acordos (id serial primary key);
    create table public.parcelas (id serial primary key);
    create table public.acordos_titulos (id serial primary key);
    create table public.acordo_titulo_vinculo (id serial primary key);
    create table public.solicitacoes_confirmacao_pagamento (id serial primary key);
    create or replace function public.carteira_safra_situacoes(p_ano text, p_semestre text default null)
      returns jsonb language sql stable as $f$ select '${SIT}'::jsonb $f$;
    create or replace function public.carteira_em_aberto_por_status_academico(p_ano text, p_semestre text default null)
      returns jsonb language sql stable as $f$ select '${ACA}'::jsonb $f$;
    create or replace function public.carteira_pendencias_por_motivo(p_ano text, p_semestre text default null)
      returns jsonb language sql stable as $f$ select '${PEN}'::jsonb $f$;
  `);
  await db.exec(CAMADA_SEM_FOTO);
  await db.exec(POLITICA);
  // uma fotografia de partida, nos três recortes
  await db.query("select public.carteira_efetividade_snapshot_recalcular()");
});

const marcas = async () =>
  (await db.query(`select recorte, bloco, invalidada_em, invalidada_por
                     from public.carteira_efetividade_snapshot order by recorte, bloco`)).rows;
const desatualizadas = async () =>
  Number((await db.query(`select count(*) n from public.carteira_efetividade_snapshot
                           where invalidada_em is not null`)).rows[0].n);
const ler = async (bloco = "situacoes", ano = "2024") =>
  (await db.query(`select public.carteira_efetividade_ler('${bloco}','${ano}') j`)).rows[0].j;
const envelhecer = (min) =>
  db.exec(`update public.carteira_efetividade_snapshot
              set gerado_em = now() - interval '${min} minutes'`);

describe("marcar é barato e é por statement", () => {
  it("a fotografia nasce em dia", async () => {
    expect(await desatualizadas()).toBe(0);
    expect((await ler()).snapshot.desatualizada).toBe(false);
  });

  it("os gatilhos são de STATEMENT, nunca de linha", async () => {
    const { rows } = await db.query(`
      select c.relname tabela, t.tgname, (t.tgtype & 1) = 0 por_statement
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgname = 'zz_efetividade_invalidar' and not t.tgisinternal
       order by 1`);
    expect(rows.length).toBe(6);
    expect(rows.map((r) => r.tabela)).toEqual([
      "acordo_titulo_vinculo", "acordos", "acordos_titulos",
      "pagamentos", "parcelas", "solicitacoes_confirmacao_pagamento"]);
    for (const r of rows) expect(r.por_statement).toBe(true);
  });

  it("um lote de mil linhas marca UMA vez, não mil", async () => {
    await db.exec("insert into public.pagamentos (valor) select g from generate_series(1,1000) g;");
    // três recortes marcados × três blocos = nove linhas, independente do lote
    expect(await desatualizadas()).toBe(9);
    const m = await marcas();
    expect(new Set(m.map((x) => String(x.invalidada_em))).size).toBe(1);
    expect(new Set(m.map((x) => x.invalidada_por))).toEqual(new Set(["pagamentos"]));
  });

  it("insert, update e delete marcam — qualquer um deles", async () => {
    for (const [i, sql] of [
      ["pagamentos", "insert into public.pagamentos (valor) values (1)"],
      ["acordos", "insert into public.acordos default values"],
      ["parcelas", "insert into public.parcelas default values"],
    ]) {
      await db.query("select public.carteira_efetividade_snapshot_recalcular()");
      expect(await desatualizadas()).toBe(0);
      await db.exec(sql + ";");
      expect(await desatualizadas()).toBe(9);
      expect((await marcas())[0].invalidada_por).toBe(i);
    }
    await db.query("select public.carteira_efetividade_snapshot_recalcular()");
    await db.exec("delete from public.pagamentos;");
    expect(await desatualizadas()).toBe(9);
  });

  it("a marca guarda a PRIMEIRA mudança do ciclo, não a última", async () => {
    await db.exec("insert into public.pagamentos (valor) values (1);");
    const primeira = (await marcas())[0].invalidada_em;
    await db.exec("insert into public.acordos default values;");
    expect(String((await marcas())[0].invalidada_em)).toBe(String(primeira));
    // e quem marcou continua sendo o primeiro, não o último
    expect((await marcas())[0].invalidada_por).toBe("pagamentos");
  });
});

describe("o que o BOTÃO chama só marca", () => {
  it("pedir_atualizacao marca e NÃO reconstrói", async () => {
    const antes = (await marcas())[0].gerado_em;
    const r = (await db.query("select public.carteira_efetividade_pedir_atualizacao('2024') j")).rows[0].j;
    expect(r.marcadas).toBe(3);
    expect(r.reconstroi_em_ate_minutos).toBe(5);
    // gerado_em NÃO mudou: nada foi recalculado dentro da chamada
    expect(String((await marcas())[0].gerado_em)).toBe(String(antes));
  });

  it("marca só o recorte pedido", async () => {
    await db.query("select public.carteira_efetividade_pedir_atualizacao('2024')");
    const m = await marcas();
    expect(m.filter((x) => x.recorte === "2024" && x.invalidada_em).length).toBe(3);
    expect(m.filter((x) => x.recorte !== "2024" && x.invalidada_em).length).toBe(0);
  });

  it("não sobrescreve a marca de um gatilho anterior", async () => {
    await db.exec("insert into public.pagamentos (valor) values (1);");
    await db.query("select public.carteira_efetividade_pedir_atualizacao('2024')");
    expect((await marcas())[0].invalidada_por).toBe("pagamentos");
  });

  it("recusa quem não passa pelo portão", async () => {
    await db.exec("update public.pode set ok=false;");
    await expect(db.query("select public.carteira_efetividade_pedir_atualizacao()"))
      .rejects.toThrow(/Acesso negado/);
  });
});

describe("o atendedor reconstrói fora da requisição", () => {
  it("reconstrói o que está marcado e limpa a marca", async () => {
    await db.exec("insert into public.pagamentos (valor) values (1);");
    await envelhecer(10);
    const r = (await db.query("select public.carteira_efetividade_atender_pedidos() j")).rows[0].j;
    expect(r.reconstruidos.sort()).toEqual(["2024", "2025", "2026/1"]);
    expect(await desatualizadas()).toBe(0);
  });

  it("não faz nada quando nada está marcado", async () => {
    await envelhecer(10);
    const r = (await db.query("select public.carteira_efetividade_atender_pedidos() j")).rows[0].j;
    expect(r.reconstruidos).toEqual([]);
  });

  it("respeita o piso de 4 minutos — não vira moedor", async () => {
    await db.exec("insert into public.pagamentos (valor) values (1);");
    // fotografia recém-tirada: marcada, mas nova demais para reconstruir
    const r = (await db.query("select public.carteira_efetividade_atender_pedidos() j")).rows[0].j;
    expect(r.reconstruidos).toEqual([]);
    expect(await desatualizadas()).toBe(9);
  });

  it("não é exposto a authenticated — é o cron que chama", async () => {
    const { rows } = await db.query(`select grantee from information_schema.routine_privileges
                                      where routine_name='carteira_efetividade_atender_pedidos'
                                        and grantee in ('authenticated','anon','PUBLIC')`);
    expect(rows).toEqual([]);
  });

  it("declara o próprio statement_timeout — é a função pesada", async () => {
    const { rows } = await db.query(`select unnest(proconfig) c from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='carteira_efetividade_atender_pedidos'`);
    expect(rows.map((r) => r.c)).toContain("statement_timeout=240s");
  });
});

describe("a marca sobrevive ao recálculo que falha", () => {
  it("se o recálculo aborta, a marca FICA e o próximo ciclo tenta de novo", async () => {
    await db.exec("insert into public.pagamentos (valor) values (1);");
    await envelhecer(10);
    // a composição deixa de fechar: o recálculo tem de abortar
    await db.exec(`create or replace function public.carteira_em_aberto_por_status_academico(p_ano text, p_semestre text default null)
      returns jsonb language sql stable as $f$ select jsonb_build_object('total',
        jsonb_build_object('valor', 9999.0, 'alunos', 30, 'titulos', 120)) $f$;`);
    await expect(db.query("select public.carteira_efetividade_atender_pedidos()"))
      .rejects.toThrow(/nao fecha com a linha Em aberto/);
    expect(await desatualizadas()).toBe(9);
  });
});

describe("as rotinas e o que elas cobrem", () => {
  it("rede de segurança de 20 em 20 minutos e atendedor de 5 em 5 minutos", async () => {
    const { rows } = await db.query("select jobname, schedule from cron.job order by jobname");
    expect(rows).toEqual([
      { jobname: "carteira_efetividade_atender_pedidos", schedule: "*/5 * * * *" },
      { jobname: "carteira_efetividade_rede_de_seguranca", schedule: "*/20 * * * *" },
    ]);
  });

  it("a leitura expõe desatualizada e quando foi invalidada", async () => {
    await db.exec("insert into public.pagamentos (valor) values (1);");
    const s = await ler();
    expect(s.snapshot.desatualizada).toBe(true);
    expect(s.snapshot.invalidada_por).toBe("pagamentos");
    expect(s.snapshot.invalidada_em).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("nenhuma regra financeira na política", () => {
    const corpo = POLITICA.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const t of ["acordos_titulos", "pagamentos", "parcelas", "alunos", "prime_extrato"]) {
      expect(corpo).not.toMatch(new RegExp(`(select|from)\\s+public\\.${t}\\b`));
    }
  });

  it("casos NÃO ganha gatilho — não altera as seis linhas nem a composição", () => {
    const corpo = POLITICA.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(corpo).not.toMatch(/'casos'/);
  });
});

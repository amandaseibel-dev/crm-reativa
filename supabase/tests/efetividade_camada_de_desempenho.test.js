// A CAMADA DE DESEMPENHO da Efetividade, em PostgreSQL real.
//
// O que importa provar, e por que:
//
//  - a camada NÃO contém regra: nenhum SELECT sobre `acordos_titulos`,
//    `pagamentos`, `parcelas`, `alunos` ou `prime_*`. Ela só guarda o que as
//    três funções oficiais devolvem. Se a regra morasse aqui também, haveria
//    duas definições de "em aberto" e a tela poderia divergir de si mesma;
//  - o payload é gravado VERBATIM — o mesmo jsonb, chave por chave;
//  - a TRAVA: se a composição acadêmica não fechar com o balde `em_aberto` das
//    seis linhas do mesmo recorte, o recálculo ABORTA e nada é gravado. É esta
//    trava que impede a tela de exibir divergência financeira interna;
//  - a leitura devolve `gerado_em` — leitura que deixou de ser ao vivo tem de
//    dizer de quando é;
//  - a ACL fecha: tabela sem nada para `authenticated`/`anon`, TRUNCATE
//    incluído, porque RLS não cobre TRUNCATE;
//  - sem fotografia a leitura devolve `sem_snapshot`, nunca vazio — vazio é
//    indistinguível de "não há carteira";
//  - o recálculo declara o próprio `statement_timeout`, que é o que permite à
//    gestão disparar pelo navegador sem ser cortada pelo teto de 8 s do papel.
//
// Os números deste teste são INVENTADOS.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRACAO = readFileSync(
  resolve(AQUI, "..", "migrations", "20261007210000_efetividade_camada_de_desempenho.sql"), "utf8");

// Sem a primeira fotografia e sem o cron: as duas dependem das funções oficiais
// de produção. Todo objeto novo entra.
const SEM_PRIMEIRA_FOTO = MIGRACAO.slice(0, MIGRACAO.indexOf("-- --------------------------------------------------- 4."));

// as três funções oficiais, dubladas pelo teste
const SIT = (aberto) => JSON.stringify({
  recorte: "2024", natureza: "COBERTURA_HISTORICA",
  situacoes: {
    entrou: { alunos: 50, titulos: 200, valor: 10000.0 },
    em_aberto: aberto,
    pago: { alunos: 5, titulos: 10, valor: 1000.0 },
  },
  conferencia: { fecha: true },
});
const ACA = (total) => JSON.stringify({
  recorte: "2024", total,
  linhas: [{ status: "Formado", alunos: total.alunos, titulos: total.titulos, valor: total.valor }],
  fonte_academica: { importacao_atualizada_em: "2026-08-04T15:21:17Z" },
});
const PEN = JSON.stringify({ recorte: "2024", motivos: [{ motivo: "em_validacao", valor: 77.0 }] });

let db;

const oficiais = (sitAberto, acaTotal) => db.exec(`
  create or replace function public.carteira_safra_situacoes(p_ano text, p_semestre text default null)
    returns jsonb language sql stable as $f$ select '${SIT(sitAberto)}'::jsonb $f$;
  create or replace function public.carteira_em_aberto_por_status_academico(p_ano text, p_semestre text default null)
    returns jsonb language sql stable as $f$ select '${ACA(acaTotal)}'::jsonb $f$;
  create or replace function public.carteira_pendencias_por_motivo(p_ano text, p_semestre text default null)
    returns jsonb language sql stable as $f$ select '${PEN}'::jsonb $f$;
`);

const FECHA = { alunos: 30, titulos: 120, valor: 4000.0 };

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
    create table cron.job (jobname text);
    create function cron.schedule(a text, b text, c text) returns bigint language sql as $f$ select 1::bigint $f$;
    create function auth.role() returns text language sql stable as $f$ select 'service_role'::text $f$;
    create function auth.jwt() returns jsonb language sql stable as $f$ select null::jsonb $f$;
    create function public.usuario_e_gestao() returns boolean language sql stable as $f$ select true $f$;
    create table public.pode (ok boolean); insert into public.pode values (true);
    create function public.carteira_2026_1_pode_ler() returns boolean language sql stable
      as $f$ select coalesce((select ok from public.pode limit 1), false) $f$;
  `);
  await oficiais(FECHA, FECHA);
  await db.exec(SEM_PRIMEIRA_FOTO);
});

const recalc = (r = "2024") =>
  db.query(`select public.carteira_efetividade_snapshot_recalcular('${r}') j`);
const ler = async (bloco, ano = "2024", sem = null) =>
  (await db.query(`select public.carteira_efetividade_ler('${bloco}','${ano}',${sem ? `'${sem}'` : "null"}) j`))
    .rows[0].j;

describe("a camada não contém regra", () => {
  it("não consulta nenhuma tabela de origem financeira ou acadêmica", () => {
    const corpo = MIGRACAO.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const tabela of ["acordos_titulos", "pagamentos", "parcelas", "alunos",
                          "prime_titulo_semestre", "prime_extrato", "acordos"]) {
      expect(corpo).not.toMatch(new RegExp(`from\\s+public\\.${tabela}\\b`));
    }
  });

  it("não reintroduz universo concorrente algum", () => {
    // Filtra comentário ANTES de proibir: o cabeçalho cita os dois nomes de
    // propósito, para registrar que foram descartados. Proibir no texto cru
    // acertaria a documentação em vez do código.
    const corpo = MIGRACAO.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(corpo).not.toMatch(/carteira_academico_universo/);
    expect(corpo).not.toMatch(/carteira_academico_saldo/);
  });

  it("chama as três funções oficiais e mais nenhuma", () => {
    const chamadas = [...MIGRACAO.matchAll(/public\.(carteira_[a-z_0-9]+)\(/g)].map((m) => m[1]);
    const externas = [...new Set(chamadas)].filter((n) => !n.startsWith("carteira_efetividade"));
    expect(externas.sort()).toEqual([
      "carteira_2026_1_pode_ler",
      "carteira_em_aberto_por_status_academico",
      "carteira_pendencias_por_motivo",
      "carteira_safra_situacoes",
    ]);
  });
});

describe("grava verbatim e diz de quando é", () => {
  beforeEach(async () => { await recalc(); });

  it("o payload guardado é o mesmo jsonb que a função oficial devolveu", async () => {
    const guardado = await ler("situacoes");
    const oficial = (await db.query("select public.carteira_safra_situacoes('2024') j")).rows[0].j;
    for (const k of Object.keys(oficial)) expect(guardado[k]).toEqual(oficial[k]);
  });

  it("a leitura carrega gerado_em e o bloco", async () => {
    const s = await ler("academico");
    expect(s.snapshot.bloco).toBe("academico");
    expect(s.snapshot.gerado_em).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("os três blocos ficam gravados, do mesmo instante", async () => {
    const { rows } = await db.query(`select bloco, gerado_em from public.carteira_efetividade_snapshot
                                      where recorte='2024' order by bloco`);
    expect(rows.map((r) => r.bloco)).toEqual(["academico", "pendencias", "situacoes"]);
    expect(new Set(rows.map((r) => String(r.gerado_em))).size).toBe(1);
  });

  it("bloco desconhecido é recusado, não devolve silêncio", async () => {
    await expect(ler("inventado")).rejects.toThrow(/Bloco desconhecido/);
  });
});

describe("a trava da divergência interna", () => {
  it("ABORTA quando a composição não fecha com a linha Em aberto — e não grava", async () => {
    await oficiais(FECHA, { alunos: 30, titulos: 120, valor: 4805.7 });
    await expect(recalc()).rejects.toThrow(/nao fecha com a linha Em aberto/);
    const { rows } = await db.query("select count(*) n from public.carteira_efetividade_snapshot");
    expect(Number(rows[0].n)).toBe(0);
  });

  it("ABORTA por divergência de alunos, não só de valor", async () => {
    await oficiais(FECHA, { alunos: 31, titulos: 120, valor: 4000.0 });
    await expect(recalc()).rejects.toThrow(/nao fecha com a linha Em aberto/);
  });

  it("ABORTA por divergência de títulos", async () => {
    await oficiais(FECHA, { alunos: 30, titulos: 121, valor: 4000.0 });
    await expect(recalc()).rejects.toThrow(/nao fecha com a linha Em aberto/);
  });

  it("GRAVA quando os três números fecham", async () => {
    const j = (await recalc()).rows[0].j;
    expect(j.recortes[0].composicao_fecha).toBe(true);
    expect(Number(j.recortes[0].em_aberto)).toBe(4000.0);
  });

  it("ABORTA quando o universo vem vazio", async () => {
    await db.exec(`create or replace function public.carteira_safra_situacoes(p_ano text, p_semestre text default null)
      returns jsonb language sql stable as $f$ select jsonb_build_object('situacoes',
        jsonb_build_object('entrou', jsonb_build_object('valor', 0),
                           'em_aberto', jsonb_build_object('valor', 0, 'alunos', 0, 'titulos', 0))) $f$;`);
    await db.exec(`create or replace function public.carteira_em_aberto_por_status_academico(p_ano text, p_semestre text default null)
      returns jsonb language sql stable as $f$ select jsonb_build_object('total',
        jsonb_build_object('valor', 0, 'alunos', 0, 'titulos', 0)) $f$;`);
    await expect(recalc()).rejects.toThrow(/universo vazio/);
  });
});

describe("portão e ACL", () => {
  it("a tabela não dá nada a authenticated nem anon — TRUNCATE incluído", async () => {
    const { rows } = await db.query(`select grantee, privilege_type from information_schema.role_table_grants
                                      where table_name='carteira_efetividade_snapshot'
                                        and grantee in ('authenticated','anon','PUBLIC')`);
    expect(rows).toEqual([]);
    const t = await db.query(`select relrowsecurity from pg_class where relname='carteira_efetividade_snapshot'`);
    expect(t.rows[0].relrowsecurity).toBe(true);
  });

  it("anon não executa nenhuma das duas funções", async () => {
    const { rows } = await db.query(`select routine_name, grantee from information_schema.routine_privileges
                                      where routine_name like 'carteira_efetividade%'
                                        and grantee in ('anon','PUBLIC')`);
    expect(rows).toEqual([]);
  });

  it("a leitura recusa quem não passa pelo portão", async () => {
    await db.exec("update public.pode set ok=false;");
    await expect(ler("situacoes")).rejects.toThrow(/Acesso negado/);
  });

  it("a escrita recusa quem não é service_role nem gestão", async () => {
    await db.exec(`
      create or replace function auth.role() returns text language sql stable as $f$ select 'authenticated'::text $f$;
      create or replace function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
      create or replace function public.usuario_e_gestao() returns boolean language sql stable as $f$ select false $f$;`);
    await expect(recalc()).rejects.toThrow(/Acesso negado/);
  });

  it("o recálculo declara o próprio statement_timeout — é o que fura o teto de 8s do papel", async () => {
    const { rows } = await db.query(`select unnest(proconfig) c from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='carteira_efetividade_snapshot_recalcular'`);
    expect(rows.map((r) => r.c)).toContain("statement_timeout=240s");
  });
});

describe("sem fotografia", () => {
  it("a leitura diz sem_snapshot em vez de devolver vazio", async () => {
    const s = await ler("situacoes");
    expect(s.sem_snapshot).toBe(true);
    expect(s.recorte).toBe("2024");
    expect(s.bloco).toBe("situacoes");
  });

  it("2026/1 vira recorte com barra, não '2026'", async () => {
    const s = await ler("situacoes", "2026", "1");
    expect(s.recorte).toBe("2026/1");
  });
});

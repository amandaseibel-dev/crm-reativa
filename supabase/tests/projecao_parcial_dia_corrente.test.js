// =============================================================================
// PROJEÇÃO PARCIAL DESDE O 1º DIA ÚTIL — regra da gestão de 03/11/2026
//
// O que se prova aqui:
//   1. a ARITMÉTICA da regra nova, rodada em Postgres de verdade (PGlite) com o
//      helper public.dias_uteis e os feriados reais de novembro/2026;
//   2. que a proposta de SQL muda SÓ essa regra — não encosta em pagamento,
//      meta, faixa de comissão nem tabela, e repõe os grants que o
//      CREATE OR REPLACE devolve para PUBLIC;
//   3. que o rollback é o inverso exato.
//
// Por que a "data de hoje" é PARÂMETRO e não current_date: dois testes do
// repositório já quebraram por depender do relógio do CI (virada do dia, fuso).
// Aqui as datas de novembro/2026 são o ASSUNTO do teste (1º dia útil, dia
// intermediário, feriado, mês fechado), injetadas de fora — não "hoje" —, então
// não vencem nem dependem do TZ da máquina.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const BASE = "docs/analises/projecao-parcial-dia-corrente";
const PROPOSTA = readFileSync(`${BASE}/proposta.sql`, "utf8");
const ROLLBACK = readFileSync(`${BASE}/rollback.sql`, "utf8");
const semComentario = (s) =>
  s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toLowerCase();

// -----------------------------------------------------------------------------
// 1. A REGRA, em Postgres de verdade
// -----------------------------------------------------------------------------
describe("regra: o dia corrente entra na base do ritmo (PGlite)", () => {
  let db;

  beforeAll(async () => {
    db = new PGlite();
    // Helper e tabela de feriados como estão em produção (helper de 2026-09-03).
    await db.exec(`
      create table public.feriados (
        data date primary key,
        nome text not null,
        abrangencia text not null,
        considerar boolean not null default true
      );
      insert into public.feriados (data, nome, abrangencia, considerar) values
        ('2026-11-02','Finados','nacional',true),
        ('2026-11-15','Proclamacao da Republica','nacional',true),
        ('2026-11-20','Consciencia Negra','nacional',true),
        ('2026-12-25','Natal','nacional',true);

      create or replace function public.dias_uteis(p_ini date, p_fim date)
        returns integer language sql stable security definer set search_path to 'public'
      as $f$
        select count(*)::int
        from generate_series(p_ini, p_fim, interval '1 day') d
        where extract(isodow from d) < 6
          and not exists (
            select 1 from public.feriados f
            where f.data = d::date and f.considerar
          );
      $f$;

      -- Mesmas cinco linhas que o patch deixa em projecao_calcular_filial e
      -- projecao_calcular_operador, com v_hoje recebido de fora.
      create or replace function public.regra(p_mes text, p_hoje date, p_hon numeric)
        returns table(base int, total int, restantes int, projecao numeric, parcial boolean)
        language plpgsql as $f$
      declare
        v_ini date := to_date(p_mes || '-01', 'YYYY-MM-DD');
        v_fim date := (to_date(p_mes || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date;
        v_du_rest int; v_du_pass int; v_du_total int; v_parcial boolean;
      begin
        v_du_rest  := public.dias_uteis(greatest(p_hoje, v_ini), v_fim);
        v_du_total := public.dias_uteis(v_ini, v_fim);
        v_du_pass  := public.dias_uteis(v_ini, least(p_hoje, v_fim));
        v_parcial  := (p_hoje between v_ini and v_fim) and public.dias_uteis(p_hoje, p_hoje) = 1;
        return query select v_du_pass, v_du_total, v_du_rest,
          case when v_du_pass > 0 then round((p_hon / v_du_pass) * v_du_total, 2) else p_hon end,
          v_parcial;
      end $f$;
    `);
  });

  afterAll(async () => { await db?.close(); });

  const regra = async (mes, hoje, hon) =>
    (await db.query("select * from public.regra($1,$2,$3)", [mes, hoje, hon])).rows[0];

  it("novembro/2026 tem 19 dias úteis: 21 dias de semana menos Finados (02, seg) e Consciência Negra (20, sex)", async () => {
    const { rows } = await db.query(`
      select public.dias_uteis('2026-11-01','2026-11-30') as com_feriado,
             (select count(*)::int from generate_series('2026-11-01'::date,'2026-11-30'::date,interval '1 day') d
               where extract(isodow from d) < 6) as sem_feriado`);
    expect(rows[0].com_feriado).toBe(19);
    expect(rows[0].sem_feriado).toBe(21);
  });

  it("1º DIA ÚTIL (03/11): base 1, projeção = acumulado × 19, marcada como parcial", async () => {
    const r = await regra("2026-11", "2026-11-03", "4073.80");
    expect(r.base).toBe(1);
    expect(r.total).toBe(19);
    expect(Number(r.projecao)).toBe(77402.2); // 4.073,80 / 1 × 19 — exemplo da gestão
    expect(r.parcial).toBe(true);
    // o dia corrente conta dos dois lados de propósito: ele ainda vai fechar
    expect(r.restantes).toBe(19);
  });

  it("DIA INTERMEDIÁRIO (10/11): base conta os fechados MAIS o dia em andamento", async () => {
    const r = await regra("2026-11", "2026-11-10", "20000");
    expect(r.base).toBe(6); // 3,4,5,6,9 fechados + 10 em andamento
    expect(Number(r.projecao)).toBe(63333.33); // 20.000 / 6 × 19
    expect(r.parcial).toBe(true);
    expect(r.restantes).toBe(14);
  });

  it("FERIADO (20/11, sexta): não entra na base e a projeção não é parcial", async () => {
    const r = await regra("2026-11", "2026-11-20", "50000");
    expect(r.base).toBe(13); // nenhum dia em andamento: o feriado não abre
    expect(Number(r.projecao)).toBe(73076.92); // 50.000 / 13 × 19
    expect(r.parcial).toBe(false);
  });

  it("FERIADO ANTES DO 1º DIA ÚTIL (02/11, Finados): base 0, projeção = realizado", async () => {
    const r = await regra("2026-11", "2026-11-02", "1200");
    expect(r.base).toBe(0);
    expect(Number(r.projecao)).toBe(1200); // sem base não se inventa ritmo
    expect(r.parcial).toBe(false);
  });

  it("FIM DE SEMANA (14/11, sábado): base só com os dias fechados, não é parcial", async () => {
    const r = await regra("2026-11", "2026-11-14", "40000");
    expect(r.base).toBe(9); // 3,4,5,6,9,10,11,12,13
    expect(r.parcial).toBe(false);
  });

  it("MÊS FECHADO (consultado em dezembro): base = total, projeção = realizado, sem selo", async () => {
    const r = await regra("2026-11", "2026-12-01", "120000");
    expect(r.base).toBe(19);
    expect(r.total).toBe(19);
    expect(Number(r.projecao)).toBe(120000);
    expect(r.parcial).toBe(false);
    expect(r.restantes).toBe(0);
  });

  it("MÊS FUTURO: sem dia fechado nem dia em andamento, projeção = realizado", async () => {
    const r = await regra("2026-12", "2026-11-03", "0");
    expect(r.base).toBe(0);
    expect(Number(r.projecao)).toBe(0);
    expect(r.parcial).toBe(false);
  });

  it("a data local de São Paulo é calculável no banco (v_hoje do patch)", async () => {
    const { rows } = await db.query(
      "select (now() at time zone 'America/Sao_Paulo')::date is not null as ok");
    expect(rows[0].ok).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 2. A PROPOSTA DE SQL — escopo e segurança
// -----------------------------------------------------------------------------
describe("proposta.sql: muda a regra e nada além dela", () => {
  const sql = semComentario(PROPOSTA);

  it("ataca exatamente as três funções que calculam projeção", () => {
    expect(sql).toContain("'projecao_calcular_filial', 'projecao_calcular_operador'");
    expect(sql).toContain("p.proname = 'tv_snapshot_calcular'");
  });

  it("tira o desconto do dia corrente e guarda contra ele sobrar", () => {
    expect(PROPOSTA).toContain("greatest\\(v_du_pass - 1, 0\\)");
    expect(PROPOSTA).toContain("greatest\\(0, v_du_ate - 1\\)");
    expect(sql).toContain("strpos(v_novo, 'v_du_pass - 1') > 0");
    expect(sql).toContain("strpos(v_novo, 'v_du_ate - 1') > 0");
  });

  it("introduz projecao_parcial e o dia local, e aborta se alguma âncora não casar", () => {
    // dentro do SQL o literal vai com as aspas dobradas
    expect(PROPOSTA).toContain("''projecao_parcial'', v_parcial,");
    expect(PROPOSTA).toContain("(now() at time zone ''America/Sao_Paulo'')::date");
    expect(sql.match(/raise exception/g).length).toBeGreaterThanOrEqual(10);
  });

  it("preserva a conta da projeção (só o denominador muda)", () => {
    expect(sql).toContain("(v_hon_mes / v_du_pass) * v_du_total");
    expect(sql).toContain("v_hon::numeric / v_du_ate * v_du_mes");
  });

  it("repõe os grants que o CREATE OR REPLACE devolve para PUBLIC", () => {
    expect(sql).toContain("revoke all on function public.projecao_calcular_filial(text)        from public, anon, authenticated");
    expect(sql).toContain("revoke all on function public.projecao_calcular_operador(text,text) from public, anon, authenticated");
    expect(sql).toContain("revoke all on function public.tv_snapshot_calcular() from public, anon");
    expect(sql).toContain("grant execute on function public.tv_snapshot_calcular() to authenticated, service_role");
  });

  it("não cria, apaga nem reescreve dado, tabela, meta ou comissão", () => {
    expect(sql).not.toMatch(/\bdrop\b|\btruncate\b|\binsert into\b|\bdelete from\b|\balter table\b/);
    expect(sql).not.toMatch(/metas_projecao|public\.pagamentos|m1_percentual|comissao/);
    expect(sql).not.toMatch(/cron\.|alter role|alter database/);
  });

  it("roda em transação", () => {
    expect(sql).toMatch(/^\s*begin;/m);
    expect(sql).toMatch(/^\s*commit;/m);
  });
});

// -----------------------------------------------------------------------------
// 3. O ROLLBACK — inverso exato
// -----------------------------------------------------------------------------
describe("rollback.sql: desfaz a regra e repõe os grants", () => {
  const sql = semComentario(ROLLBACK);

  it("devolve o desconto do dia corrente nas três funções", () => {
    expect(ROLLBACK).toContain("if v_hoje <= v_fim then v_du_pass := greatest(v_du_pass - 1, 0); end if;");
    expect(ROLLBACK).toContain("v_du_ate := greatest(0, v_du_ate - 1);");
    expect(ROLLBACK).toContain("v_du_rest := greatest(0, v_du_mes - v_du_ate);");
  });

  it("remove projecao_parcial e volta v_hoje para current_date", () => {
    expect(ROLLBACK).toContain("v_hoje date := current_date;");
    expect(sql).toContain("strpos(v_novo, 'projecao_parcial') > 0");
  });

  it("repõe os mesmos grants e não toca em dado", () => {
    expect(sql).toContain("grant execute on function public.tv_snapshot_calcular() to authenticated, service_role");
    expect(sql).not.toMatch(/\bdrop\b|\btruncate\b|\binsert into\b|\bdelete from\b|\balter table\b/);
  });
});

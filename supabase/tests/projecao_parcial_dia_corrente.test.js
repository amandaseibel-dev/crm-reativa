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

      -- Mesmas linhas que o patch deixa em projecao_calcular_filial e
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
        if p_hoje <= v_fim then
          v_du_pass := greatest(public.dias_uteis(v_ini, p_hoje - 1), 1);
        end if;
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

  it("1º DIA ÚTIL (03/11): nenhum dia fechado, o piso de 1 vale, projeção = acumulado × 19", async () => {
    const r = await regra("2026-11", "2026-11-03", "4073.80");
    expect(r.base).toBe(1);
    expect(r.total).toBe(19);
    expect(Number(r.projecao)).toBe(77402.2); // 4.073,80 / 1 × 19 — exemplo da gestão
    expect(r.parcial).toBe(true);
    // o dia corrente conta como restante: ele ainda vai fechar
    expect(r.restantes).toBe(19);
  });

  it("2º DIA ÚTIL (04/11): a base é 1, NÃO 2 — só o dia 3 fechou", async () => {
    // A decisão da gestão em 04/11/2026: o dia corrente não vira divisor, então
    // hoje é o 1º dia de projeção. Dividir por 2 na virada do relógio cortaria
    // a projeção pela metade sem que nada tivesse acontecido.
    const r = await regra("2026-11", "2026-11-04", "5371.41");
    expect(r.base).toBe(1);
    expect(Number(r.projecao)).toBe(102056.79); // 5.371,41 / 1 × 19
    expect(r.parcial).toBe(true);
    expect(r.restantes).toBe(18);
  });

  it("DIA INTERMEDIÁRIO (10/11): base = só os dias que fecharam", async () => {
    const r = await regra("2026-11", "2026-11-10", "20000");
    expect(r.base).toBe(5); // 3,4,5,6,9 — o dia 10 está em andamento
    expect(Number(r.projecao)).toBe(76000); // 20.000 / 5 × 19
    expect(r.parcial).toBe(true);
    expect(r.restantes).toBe(14);
  });

  it("FERIADO (20/11, sexta): não entra na base e a projeção não é parcial", async () => {
    const r = await regra("2026-11", "2026-11-20", "50000");
    expect(r.base).toBe(13); // 3..19; o feriado não abre e não fecha nada
    expect(Number(r.projecao)).toBe(73076.92); // 50.000 / 13 × 19
    expect(r.parcial).toBe(false);
  });

  it("FERIADO ANTES DO 1º DIA ÚTIL (02/11, Finados): o piso de 1 segura a conta", async () => {
    const r = await regra("2026-11", "2026-11-02", "1200");
    expect(r.base).toBe(1); // nenhum dia fechado ainda — piso
    expect(Number(r.projecao)).toBe(22800); // 1.200 × 19
    expect(r.parcial).toBe(false);
  });

  it("FIM DE SEMANA (14/11, sábado): base com os 9 dias fechados, não é parcial", async () => {
    const r = await regra("2026-11", "2026-11-14", "40000");
    expect(r.base).toBe(9); // 3,4,5,6,9,10,11,12,13 — todos fecharam
    expect(Number(r.projecao)).toBe(84444.44);
    expect(r.parcial).toBe(false);
  });

  it("a base nunca conta o dia corrente: 04/11 e 05/11 diferem em 1", async () => {
    const q = await regra("2026-11", "2026-11-04", "10000");
    const s = await regra("2026-11", "2026-11-05", "10000");
    expect(q.base).toBe(1);
    expect(s.base).toBe(2);
  });

  it("MÊS FECHADO (consultado em dezembro): base = total, projeção = realizado, sem selo", async () => {
    const r = await regra("2026-11", "2026-12-01", "120000");
    expect(r.base).toBe(19);
    expect(r.total).toBe(19);
    expect(Number(r.projecao)).toBe(120000);
    expect(r.parcial).toBe(false);
    expect(r.restantes).toBe(0);
  });

  it("MÊS FUTURO: sem honorário não há projeção, e não é parcial", async () => {
    const r = await regra("2026-12", "2026-11-03", "0");
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
describe("proposta.sql (patch 2): muda a base do ritmo e nada além dela", () => {
  const sql = semComentario(PROPOSTA);

  it("ataca exatamente as três funções que calculam projeção", () => {
    expect(sql).toContain("'projecao_calcular_filial', 'projecao_calcular_operador'");
    expect(sql).toContain("p.proname = 'tv_snapshot_calcular'");
  });

  it("exige o patch de 2026-11-03 aplicado, e aborta se não estiver", () => {
    // Produção já está com o patch 1 (conferido em 04/11/2026). Rodar o patch 2
    // sobre o estado de agosto produziria código incoerente, então a
    // pré-condição é conferida antes de qualquer substituição.
    // `sql` vem minúsculo de semComentario
    expect(sql).toContain("strpos(pg_get_functiondef(p.oid), 'regra 2026-11-03') = 0");
    expect(sql).toMatch(/pre-condicao nao atendida/);
  });

  it("a base passa a ser o dia FECHADO com piso de 1, no CRM e na TV", () => {
    // CRM: dias úteis de 1º do mês até ONTEM, nunca até hoje
    expect(PROPOSTA).toContain("v_du_pass := greatest(public.dias_uteis(v_ini, v_hoje - 1), 1);");
    // TV: a mesma conta, com os marcos do mês inline
    expect(PROPOSTA).toContain("v_du_ate := greatest(public.dias_uteis(date_trunc(''month'',current_date)::date, current_date - 1), 1);");
    // o piso é 1, não 0: com 0 o 1º dia útil volta a repetir o realizado
    expect(PROPOSTA).not.toContain("v_hoje - 1), 0)");
  });

  it("ancora no bloco do patch 1 e guarda contra ele sobrar", () => {
    expect(PROPOSTA).toContain("REGRA 2026-11-03");
    expect(sql).toContain("strpos(v_novo, 'regra 2026-11-03') > 0");
  });

  it("guarda contra o desconto de agosto reaparecer", () => {
    expect(sql).toContain("strpos(v_novo, 'v_du_pass - 1') > 0");
    expect(sql).toContain("strpos(v_novo, 'v_du_ate - 1') > 0");
  });

  it("preserva a conta da projeção, o payload e o dia local (vieram do patch 1)", () => {
    expect(sql).toContain("(v_hon_mes / v_du_pass) * v_du_total");
    expect(sql).toContain("v_hon::numeric / v_du_ate * v_du_mes");
    expect(PROPOSTA).toContain("''projecao_parcial'', v_parcial,");
    expect(PROPOSTA).toContain("(now() at time zone ''America/Sao_Paulo'')::date");
  });

  it("aborta em qualquer âncora ou guarda que não casar", () => {
    expect(sql.match(/raise exception/g).length).toBeGreaterThanOrEqual(10);
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
describe("rollback.sql: desfaz o patch 2 e repõe os grants", () => {
  const sql = semComentario(ROLLBACK);

  it("volta ao estado do patch 1, não ao de agosto", () => {
    // O rollback devolve `REGRA 2026-11-03` (dia corrente na base), que é onde
    // produção estava antes do patch 2. Voltar à premissa de agosto é outro
    // script — e está dito no cabeçalho, para ninguém esperar isso daqui.
    expect(ROLLBACK).toContain("REGRA 2026-11-03 (gestao): o DIA CORRENTE entra na base do ritmo");
    expect(sql).toContain("strpos(v_novo, 'regra 2026-11-03') = 0");
    expect(ROLLBACK).not.toContain("PREMISSA 2026-08-17");
  });

  it("ancora no bloco do patch 2 e guarda contra a base por dia fechado sobrar", () => {
    expect(ROLLBACK).toContain("REGRA 2026-11-04");
    expect(sql).toContain("strpos(v_novo, 'v_hoje - 1') > 0");
    expect(sql).toContain("strpos(v_novo, 'current_date - 1') > 0");
  });

  it("não encosta no payload, no dia local nem na conta", () => {
    expect(sql).not.toMatch(/dias_uteis_passados|America\/Sao_Paulo/);
  });

  it("repõe os mesmos grants e não toca em dado", () => {
    expect(sql).toContain("grant execute on function public.tv_snapshot_calcular() to authenticated, service_role");
    expect(sql).not.toMatch(/\bdrop\b|\btruncate\b|\binsert into\b|\bdelete from\b|\balter table\b/);
  });
});

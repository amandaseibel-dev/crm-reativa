// =============================================================================
// PROJEÇÃO SOMENTE POR DIAS ÚTEIS FECHADOS — regra da gestão de 04/11/2026
//
// O que se prova aqui:
//   1. a ARITMÉTICA da regra, em Postgres de verdade (PGlite), com os feriados
//      reais de novembro/2026 e um histórico de honorário DIA A DIA — é o
//      histórico diário que permite provar o corte do período, ou seja, que o
//      dinheiro de HOJE não entra na projeção;
//   2. que a proposta de SQL muda só essa regra — não encosta em pagamento,
//      meta, faixa de comissão, média diária nem tabela, e repõe os grants que
//      o CREATE OR REPLACE devolve para PUBLIC;
//   3. que o rollback volta ao estado do patch 1, e não ao de agosto.
//
// Por que a "data de hoje" é PARÂMETRO e não current_date: dois testes do
// repositório já quebraram por depender do relógio do CI (virada do dia, fuso).
// As datas de novembro/2026 são o ASSUNTO do teste (1º dia útil, dia
// intermediário, feriado, fim de semana, mês fechado), injetadas de fora — não
// "hoje" —, então não vencem nem dependem do TZ da máquina.
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
describe("regra: projeção só pelos dias úteis fechados (PGlite)", () => {
  let db;

  beforeAll(async () => {
    db = new PGlite();
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

      -- helper oficial, como está em produção (migration de 2026-09-03)
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

      -- honorário dia a dia, no lugar de public.pagamentos
      create table public.hon_dia (dia date primary key, valor numeric not null);

      -- As mesmas linhas que o patch deixa em projecao_calcular_filial, com a
      -- data de hoje recebida de fora.
      create or replace function public.regra(p_mes text, p_hoje date)
        returns table(base int, total int, restantes int,
                      realizado numeric, numerador numeric,
                      projecao numeric, aguardando boolean)
        language plpgsql as $f$
      declare
        v_ini date := to_date(p_mes || '-01', 'YYYY-MM-DD');
        v_fim date := (to_date(p_mes || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date;
        v_du_rest int; v_du_pass int; v_du_total int;
        v_aguardando boolean; v_hon_fec numeric; v_hon_mes numeric;
      begin
        select coalesce(sum(valor),0) into v_hon_mes
        from public.hon_dia where dia >= v_ini and dia <= v_fim;

        v_du_rest  := public.dias_uteis(greatest(p_hoje, v_ini), v_fim);
        v_du_total := public.dias_uteis(v_ini, v_fim);
        v_du_pass  := public.dias_uteis(v_ini, least(p_hoje - 1, v_fim));

        select coalesce(sum(valor),0) into v_hon_fec
        from public.hon_dia
        where dia >= v_ini and dia <= least(p_hoje - 1, v_fim);

        v_aguardando := (v_du_pass = 0);

        return query select v_du_pass, v_du_total, v_du_rest, v_hon_mes, v_hon_fec,
          case when v_du_pass > 0 then round((v_hon_fec / v_du_pass) * v_du_total, 2) else null end,
          v_aguardando;
      end $f$;

      -- Novembro/2026 como aconteceu: o dia 3 fechou em 5.354,85 e no dia 4,
      -- com o dia ainda em andamento, tinham entrado 16,56.
      insert into public.hon_dia (dia, valor) values
        ('2026-11-03', 5354.85),
        ('2026-11-04', 16.56);
    `);
  });

  afterAll(async () => { await db?.close(); });

  const regra = async (mes, hoje) =>
    (await db.query("select * from public.regra($1,$2)", [mes, hoje])).rows[0];

  it("novembro/2026 tem 19 dias úteis: 21 dias de semana menos Finados (02, seg) e Consciência Negra (20, sex)", async () => {
    const { rows } = await db.query(`
      select public.dias_uteis('2026-11-01','2026-11-30') as com_feriado,
             (select count(*)::int from generate_series('2026-11-01'::date,'2026-11-30'::date,interval '1 day') d
               where extract(isodow from d) < 6) as sem_feriado`);
    expect(rows[0].com_feriado).toBe(19);
    expect(rows[0].sem_feriado).toBe(21);
  });

  it("04/11: base 1 (só o dia 3 fechou) e projeção R$ 101.742,15", async () => {
    // O valor que a gestão aprovou: 5.354,85 do dia 3 fechado × 19 dias úteis.
    const r = await regra("2026-11", "2026-11-04");
    expect(r.base).toBe(1);
    expect(r.total).toBe(19);
    expect(Number(r.numerador)).toBe(5354.85);
    expect(Number(r.projecao)).toBe(101742.15);
    expect(r.aguardando).toBe(false);
  });

  it("04/11: o honorário de hoje está no realizado, mas FORA da projeção", async () => {
    const r = await regra("2026-11", "2026-11-04");
    expect(Number(r.realizado)).toBe(5371.41);  // 5.354,85 + 16,56 de hoje
    expect(Number(r.numerador)).toBe(5354.85);  // só o dia fechado
    expect(Number(r.realizado)).toBeGreaterThan(Number(r.numerador));
  });

  it("dinheiro que entra HOJE não move a projeção — ela só muda no fechamento", async () => {
    const antes = await regra("2026-11", "2026-11-04");
    await db.exec("update public.hon_dia set valor = valor + 5000 where dia = '2026-11-04';");
    const depois = await regra("2026-11", "2026-11-04");

    expect(Number(depois.projecao)).toBe(Number(antes.projecao)); // estável
    expect(Number(depois.realizado)).toBe(Number(antes.realizado) + 5000);

    // no dia seguinte, o mesmo dinheiro já conta: o dia 4 fechou
    const amanha = await regra("2026-11", "2026-11-05");
    expect(amanha.base).toBe(2);
    expect(Number(amanha.numerador)).toBe(10371.41);
    expect(Number(amanha.projecao)).toBe(98528.40); // 10.371,41 / 2 × 19

    await db.exec("update public.hon_dia set valor = valor - 5000 where dia = '2026-11-04';");
  });

  it("1º DIA ÚTIL (03/11): sem dia fechado não existe projeção", async () => {
    const r = await regra("2026-11", "2026-11-03");
    expect(r.base).toBe(0);
    expect(r.projecao).toBeNull();
    expect(r.aguardando).toBe(true);
    // o dinheiro do dia aparece no realizado, não na projeção
    expect(Number(r.realizado)).toBeGreaterThan(0);
    expect(Number(r.numerador)).toBe(0);
  });

  it("FERIADO ANTES DO 1º DIA ÚTIL (02/11, Finados): também aguardando", async () => {
    const r = await regra("2026-11", "2026-11-02");
    expect(r.base).toBe(0);
    expect(r.projecao).toBeNull();
    expect(r.aguardando).toBe(true);
  });

  it("DIA INTERMEDIÁRIO (10/11): base são os 5 dias que fecharam", async () => {
    const r = await regra("2026-11", "2026-11-10");
    expect(r.base).toBe(5); // 3,4,5,6,9
    expect(r.aguardando).toBe(false);
    expect(r.restantes).toBe(14);
  });

  it("FERIADO (20/11, sexta): não fecha nada, base são os 13 anteriores", async () => {
    const r = await regra("2026-11", "2026-11-20");
    expect(r.base).toBe(13); // 3..19
    expect(r.aguardando).toBe(false);
  });

  it("FIM DE SEMANA (14/11, sábado): os 9 dias úteis anteriores já fecharam", async () => {
    const r = await regra("2026-11", "2026-11-14");
    expect(r.base).toBe(9); // 3,4,5,6,9,10,11,12,13
    expect(r.aguardando).toBe(false);
  });

  it("MÊS FECHADO (consultado em dezembro): base = total e projeção = realizado", async () => {
    const r = await regra("2026-11", "2026-12-01");
    expect(r.base).toBe(19);
    expect(r.total).toBe(19);
    expect(Number(r.numerador)).toBe(Number(r.realizado));
    expect(Number(r.projecao)).toBe(Number(r.realizado));
    expect(r.aguardando).toBe(false);
    expect(r.restantes).toBe(0);
  });

  it("MÊS FUTURO: nada fechado, nada projetado", async () => {
    const r = await regra("2026-12", "2026-11-04");
    expect(r.base).toBe(0);
    expect(r.projecao).toBeNull();
    expect(r.aguardando).toBe(true);
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
describe("proposta.sql (patch 2): muda a projeção e nada além dela", () => {
  const sql = semComentario(PROPOSTA);

  it("ataca exatamente as três funções que calculam projeção", () => {
    expect(sql).toContain("p.proname = 'projecao_calcular_filial'");
    expect(sql).toContain("p.proname = 'projecao_calcular_operador'");
    expect(sql).toContain("p.proname = 'tv_snapshot_calcular'");
  });

  it("exige o patch de 2026-11-03 aplicado, e aborta se não estiver", () => {
    // Produção já está com o patch 1 (conferido em 04/11/2026).
    expect(sql).toContain("strpos(pg_get_functiondef(p.oid), 'regra 2026-11-03') = 0");
    expect(sql).toMatch(/pre-condicao nao atendida/);
  });

  it("o DIVISOR passa a contar só até ontem, nas três funções", () => {
    expect(PROPOSTA).toContain("v_du_pass  := public.dias_uteis(v_ini, least(v_hoje - 1, v_fim));");
    expect(PROPOSTA).toContain("least(current_date - 1, (date_trunc(''month'',current_date) + interval ''1 month - 1 day'')::date)");
    // sem piso artificial: a base pode ser 0 e aí não há projeção
    expect(PROPOSTA).not.toMatch(/greatest\(public\.dias_uteis\([^)]*\), 1\)/);
  });

  it("o NUMERADOR cobre o mesmo período do divisor", () => {
    expect(PROPOSTA).toContain("where data_pagamento >= v_ini and data_pagamento <= least(v_hoje - 1, v_fim)");
    expect(PROPOSTA).toContain("and data_pagamento <= current_date - 1;");
    // e o operador soma só as próprias linhas
    expect(PROPOSTA).toContain("and ( (v_sem and operador_email is null)");
  });

  it("sem dia fechado a projeção é nula, e o campo novo diz isso", () => {
    expect(PROPOSTA).toContain("round((v_hon_fec / v_du_pass) * v_du_total, 2) else null end;");
    expect(PROPOSTA).toContain("v_aguardando := (v_du_pass = 0);");
    expect(PROPOSTA).toContain("v_aguardando := (v_du_ate = 0);");
    expect(PROPOSTA).toContain("''projecao_aguardando_fechamento'', v_aguardando,");
  });

  it("tira o campo projecao_parcial, que deixou de fazer sentido", () => {
    expect(sql).toContain("strpos(v_novo, 'v_parcial') > 0");
  });

  it("preserva o realizado e a média diária da TV", () => {
    // v_hon_mes continua existindo: é o realizado do mês, que não muda
    expect(sql).toContain("v_hon_mes");
    expect(sql).toContain("media_diaria da tv foi alterada");
    expect(PROPOSTA).toContain("v_media_dia := case when v_du_ate > 0 then round(v_rec::numeric / v_du_ate) else 0 end;");
  });

  it("aborta em qualquer âncora ou guarda que não casar", () => {
    expect(sql.match(/raise exception/g).length).toBeGreaterThanOrEqual(15);
  });

  it("repõe os grants que o CREATE OR REPLACE devolve para PUBLIC", () => {
    expect(sql).toContain("revoke all on function public.projecao_calcular_filial(text)        from public, anon, authenticated");
    expect(sql).toContain("revoke all on function public.projecao_calcular_operador(text,text) from public, anon, authenticated");
    expect(sql).toContain("revoke all on function public.tv_snapshot_calcular() from public, anon");
    expect(sql).toContain("grant execute on function public.tv_snapshot_calcular() to authenticated, service_role");
  });

  it("não cria, apaga nem reescreve dado, tabela, meta ou comissão", () => {
    expect(sql).not.toMatch(/\bdrop\b|\btruncate\b|\binsert into\b|\bdelete from\b|\balter table\b/);
    expect(sql).not.toMatch(/metas_projecao|m1_percentual|comissao/);
    expect(sql).not.toMatch(/cron\.|alter role|alter database/);
  });

  it("roda em transação", () => {
    expect(sql).toMatch(/^\s*begin;/m);
    expect(sql).toMatch(/^\s*commit;/m);
  });
});

// -----------------------------------------------------------------------------
// 3. O ROLLBACK
// -----------------------------------------------------------------------------
describe("rollback.sql: desfaz o patch 2 e repõe os grants", () => {
  const sql = semComentario(ROLLBACK);

  it("volta ao estado do patch 1, não ao de agosto", () => {
    expect(ROLLBACK).toContain("REGRA 2026-11-03 (gestao): o DIA CORRENTE entra na base do ritmo");
    expect(ROLLBACK).not.toContain("PREMISSA 2026-08-17");
    expect(sql).toContain("strpos(v_novo, 'regra 2026-11-03') = 0");
  });

  it("devolve o divisor e o numerador antigos nas três funções", () => {
    expect(ROLLBACK).toContain("v_du_pass  := public.dias_uteis(v_ini, least(v_hoje, v_fim));");
    expect(ROLLBACK).toContain("round((v_hon_mes / v_du_pass) * v_du_total, 2) else v_hon_mes end;");
    expect(ROLLBACK).toContain("round(v_hon::numeric / v_du_ate * v_du_mes) else v_hon end;");
    expect(ROLLBACK).toContain("round(v_media_dia * v_du_mes) else v_rec end;");
  });

  it("guarda contra sobrar qualquer peça do patch 2", () => {
    expect(sql).toContain("strpos(v_novo, 'v_hon_fec') > 0");
    expect(sql).toContain("strpos(v_novo, 'v_aguardando') > 0");
    expect(sql).toContain("strpos(v_novo, 'v_rec_fec') > 0");
  });

  it("repõe os mesmos grants e não toca em dado", () => {
    expect(sql).toContain("grant execute on function public.tv_snapshot_calcular() to authenticated, service_role");
    expect(sql).not.toMatch(/\bdrop\b|\btruncate\b|\binsert into\b|\bdelete from\b|\balter table\b/);
  });
});

// "MAIOR VALOR RECUPERADO NA SEMANA" — semana de calendário, fuso de São Paulo.
//
// ACHADO: `ranking_semana_valor` nunca foi produzido (zero ocorrencias no banco,
// chave ausente do snapshot 511). O fallback `dados.ranking_semana` traz
// {operador, pagos}, SEM `valor` -- entao `porValor` sempre foi falso e a tela
// sempre mostrou "Mais pagamentos unicos". O rotulo era codigo morto.
//
// Este arquivo prova, num PostgreSQL de verdade:
//   1. a SEMANTICA da semana (segunda inicia; domingo->segunda reinicia; fuso);
//   2. o PATCH (cria a chave, troca a janela, idempotente, falha alto).
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const MIGRATION = readFileSync("supabase/migrations/20261006110000_tv_maior_valor_semana_calendario.sql", "utf-8");
const ROLLBACK = readFileSync("supabase/rollbacks/20261006110000_tv_maior_valor_semana_calendario.rollback.sql", "utf-8");

// --------------------------------------------------------------- 1. semantica
describe("semana de calendário — segunda inicia, domingo fecha", () => {
  it("SEGUNDA: nada da semana anterior entra", async () => {
    const db = await PGlite.create();
    const segunda = "2026-10-05";
    const r = await db.query(
      `select
         (date_trunc('week', $1::date)::date)::text                 as inicio,
         ('2026-10-04'::date >= date_trunc('week',$1::date)::date)  as domingo_anterior,
         ('2026-10-02'::date >= date_trunc('week',$1::date)::date)  as sexta_anterior,
         ('2026-09-29'::date >= date_trunc('week',$1::date)::date)  as semana_retrasada,
         ($1::date          >= date_trunc('week',$1::date)::date)   as a_propria_segunda`,
      [segunda]
    );
    const x = r.rows[0];
    expect(x.inicio).toBe("2026-10-05");
    expect(x.domingo_anterior).toBe(false);   // 04/10 fica de fora
    expect(x.sexta_anterior).toBe(false);
    expect(x.semana_retrasada).toBe(false);
    expect(x.a_propria_segunda).toBe(true);   // a segunda conta desde o inicio
    await db.close();
  });

  it("TERÇA A DOMINGO acumulam desde a segunda", async () => {
    const db = await PGlite.create();
    const r = await db.query(`
      select d::date::text as dia,
             (date_trunc('week', d)::date)::text as inicio,
             ('2026-10-05'::date >= date_trunc('week', d)::date) as inclui_a_segunda
        from generate_series('2026-10-06'::date,'2026-10-11'::date,'1 day') d`);
    for (const l of r.rows) {
      expect(l.inicio).toBe("2026-10-05");   // terca..domingo: mesma segunda
      expect(l.inclui_a_segunda).toBe(true);
    }
    await db.close();
  });

  it("VIRADA domingo -> segunda: a janela reinicia", async () => {
    const db = await PGlite.create();
    const r = await db.query(`
      select (date_trunc('week','2026-10-11'::date)::date)::text as inicio_no_domingo,
             (date_trunc('week','2026-10-12'::date)::date)::text as inicio_na_segunda,
             -- um pagamento de sabado 10/10 entra no domingo e sai na segunda
             ('2026-10-10'::date >= date_trunc('week','2026-10-11'::date)::date) as sabado_no_domingo,
             ('2026-10-10'::date >= date_trunc('week','2026-10-12'::date)::date) as sabado_na_segunda`);
    const x = r.rows[0];
    expect(x.inicio_no_domingo).toBe("2026-10-05");
    expect(x.inicio_na_segunda).toBe("2026-10-12");  // reiniciou
    expect(x.sabado_no_domingo).toBe(true);
    expect(x.sabado_na_segunda).toBe(false);         // nao carregou nada
    await db.close();
  });

  it("a janela MÓVEL antiga carregaria a semana anterior — é a diferença toda", async () => {
    const db = await PGlite.create();
    const r = await db.query(`
      select ('2026-10-02'::date >= '2026-10-05'::date - 6)                        as movel_inclui_sexta,
             ('2026-10-02'::date >= date_trunc('week','2026-10-05'::date)::date)   as calendario_inclui_sexta`);
    expect(r.rows[0].movel_inclui_sexta).toBe(true);
    expect(r.rows[0].calendario_inclui_sexta).toBe(false);
    await db.close();
  });

  it("FUSO: v_hoje (São Paulo) e current_date (UTC) podem cair em semanas diferentes", async () => {
    const db = await PGlite.create();
    // Segunda 05/10 00:30 em Sao Paulo = domingo 04/10 03:30 UTC.
    // Pelo relogio do servidor ainda e a semana velha; em SP ja virou.
    const r = await db.query(`
      select date_trunc('week', (timestamptz '2026-10-05 03:30:00+00'
               at time zone 'America/Sao_Paulo')::date)::date::text as semana_sao_paulo,
             date_trunc('week', (timestamptz '2026-10-05 00:30:00+00')::date)::date::text as semana_utc`);
    expect(r.rows[0].semana_sao_paulo).toBe("2026-10-05"); // ja e a semana nova
    expect(r.rows[0].semana_utc).toBe("2026-09-28");       // servidor ainda na velha
    await db.close();
  });
});

// -------------------------------------------------------------------- 2. patch
// Funcao de apoio com as MESMAS ancoras da de producao (janela e `ranking_mes`),
// e com `v_hoje` em Sao Paulo, como la. Nao e a `tv_snapshot_calcular` real
// (18 KB): o que esta sob teste e o patch, nao o calculo da TV.
const FUNCAO = `
  create table if not exists pag (data_pagamento date, valor_pago numeric,
                                  op_norm text, operador_email text, aluno_ref text);
  create or replace function public.tv_snapshot_calcular() returns jsonb
   language plpgsql stable as $f$
   declare
     v_ops text[] := array['op@x.com'];
     v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
   begin
     return (with unif as (select * from pag)
       select jsonb_build_object(
         'ranking_semana', (select coalesce(jsonb_agg(jsonb_build_object('operador', op, 'pagos', pg) order by pg desc), '[]'::jsonb)
           from (select op_norm op, count(distinct aluno_ref) pg from unif where data_pagamento >= current_date - 6 and lower(operador_email) = any(v_ops) group by op_norm order by pg desc limit 8) r),
         'ranking_mes', 1,
         'recuperado_dia', 2));
   end $f$;
`;

const defDe = async (db) =>
  (await db.query(`select pg_get_functiondef(p.oid) d from pg_proc p
     join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='tv_snapshot_calcular'`)).rows[0].d;

describe("patch — cria o indicador e troca a janela, sem reescrever a função", () => {
  it("cria ranking_semana_valor e põe os dois na semana de calendário", async () => {
    const db = await PGlite.create();
    await db.exec(FUNCAO);
    expect(await defDe(db)).not.toContain("ranking_semana_valor");

    await db.exec(MIGRATION);
    const d = await defDe(db);

    expect(d).toContain("ranking_semana_valor");
    expect(d).toContain("round(sum(valor_pago))");
    expect(d).not.toContain("current_date - 6");                 // janela antiga sumiu
    expect(d).toContain("date_trunc('week', v_hoje)::date");     // fuso de Sao Paulo
    // ranking_mes e os indicadores do dia nao foram tocados
    expect(d).toContain("'ranking_mes', 1");
    expect(d).toContain("'recuperado_dia', 2");
    await db.close();
  });

  it("a função continua executando e devolve o indicador novo", async () => {
    const db = await PGlite.create();
    await db.exec(FUNCAO);
    await db.exec(MIGRATION);
    // dois pagamentos nesta semana, um na anterior
    const seg = (await db.query(`select date_trunc('week',(now() at time zone 'America/Sao_Paulo')::date)::date d`)).rows[0].d;
    await db.query(`insert into pag values ($1, 1000, 'ANA', 'op@x.com', 'a1'),
                                           ($1, 500,  'ANA', 'op@x.com', 'a2'),
                                           ($1::date - 3, 9999, 'ANA', 'op@x.com', 'a3')`, [seg]);

    const r = (await db.query(`select public.tv_snapshot_calcular() j`)).rows[0].j;
    expect(r.ranking_semana_valor).toEqual([{ operador: "ANA", valor: 1500 }]); // 9999 ficou de fora
    await db.close();
  });

  it("é idempotente: rodar de novo não muda nada", async () => {
    const db = await PGlite.create();
    await db.exec(FUNCAO);
    await db.exec(MIGRATION);
    const primeira = await defDe(db);
    await db.exec(MIGRATION);
    expect(await defDe(db)).toBe(primeira);
    await db.close();
  });

  it("o rollback devolve exatamente o original, e é idempotente", async () => {
    const db = await PGlite.create();
    await db.exec(FUNCAO);
    const original = await defDe(db);
    await db.exec(MIGRATION);
    await db.exec(ROLLBACK);
    expect(await defDe(db)).toBe(original);
    await db.exec(ROLLBACK);
    expect(await defDe(db)).toBe(original);
    await db.close();
  });

  it("falha alto se a âncora da janela não existir", async () => {
    const db = await PGlite.create();
    await db.exec(`create or replace function public.tv_snapshot_calcular() returns jsonb
                    language sql stable as $f$ select '{"ranking_mes":1}'::jsonb $f$;`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/esperava 1 ocorrencia/);
    await db.close();
  });

  it("falha alto se a função não existir", async () => {
    const db = await PGlite.create();
    await expect(db.exec(MIGRATION)).rejects.toThrow(/nao encontrada/);
    await db.close();
  });
});

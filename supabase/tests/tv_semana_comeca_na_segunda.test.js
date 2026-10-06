// A SEMANA DA TV COMECA NA SEGUNDA.
//
// Pedido de 06/10/2026: "melhor valor recuperado nao podemos zerar nas
// segundas?". A TV usava `data_pagamento >= current_date - 6` -- janela MOVEL
// de 7 dias. Medido naquela terca, a janela comecava em 30/09: o painel ainda
// carregava cinco dias da semana anterior.
//
// Este arquivo prova duas coisas separadas, num PostgreSQL de verdade:
//
//   1. A SEMANTICA. Numa segunda-feira, a janela nova exclui a sexta anterior e
//      a janela velha inclui. E a diferenca inteira entre zerar e nao zerar.
//   2. O PATCH. A migration nao reescreve os 18 KB da funcao: le a definicao
//      viva e troca so o trecho. O teste roda a migration REAL sobre uma funcao
//      que contem a ancora e confere que so aquilo mudou, que e idempotente e
//      que falha alto se a ancora nao aparecer exatamente uma vez.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const MIGRATION = readFileSync("supabase/migrations/20261006100000_tv_semana_comeca_na_segunda.sql", "utf-8");
const ROLLBACK = readFileSync("supabase/rollbacks/20261006100000_tv_semana_comeca_na_segunda.rollback.sql", "utf-8");

const JANELA_VELHA = "data_pagamento >= current_date - 6";
const JANELA_NOVA = "data_pagamento >= date_trunc('week', current_date)::date";

// ---------------------------------------------------------------- 1. semantica
describe("semana da TV — a janela certa zera na segunda", () => {
  it("numa segunda, a janela nova exclui a sexta anterior; a velha inclui", async () => {
    const db = await PGlite.create();
    // Segunda-feira 05/10/2026. A sexta anterior foi 02/10.
    const segunda = "2026-10-05";
    const sextaAnterior = "2026-10-02";

    const r = await db.query(
      `select
         ($1::date >= $2::date - 6)                               as entra_na_janela_movel,
         ($1::date >= date_trunc('week', $2::date)::date)         as entra_na_semana_de_calendario,
         date_trunc('week', $2::date)::date::text                 as inicio_da_semana`,
      [sextaAnterior, segunda]
    );

    expect(r.rows[0].entra_na_janela_movel).toBe(true);        // o problema
    expect(r.rows[0].entra_na_semana_de_calendario).toBe(false); // a correcao
    expect(r.rows[0].inicio_da_semana).toBe("2026-10-05"); // a propria segunda
    await db.close();
  });

  it("date_trunc('week') cai na segunda em todos os dias da semana", async () => {
    const db = await PGlite.create();
    // 05/10 e segunda; 11/10 e domingo. Todos devem truncar para 05/10.
    const r = await db.query(`
      select array_agg(distinct date_trunc('week', d)::date::text) as inicios
        from generate_series('2026-10-05'::date, '2026-10-11'::date, '1 day') d`);
    expect(r.rows[0].inicios).toEqual(["2026-10-05"]);
    await db.close();
  });
});

// -------------------------------------------------------------------- 2. patch
// Funcao de apoio com a MESMA ancora da de producao. Nao e a
// `tv_snapshot_calcular` real (18 KB): o que esta sob teste e o mecanismo do
// patch, nao o calculo da TV -- que esta migration nao toca.
const FUNCAO_COM_ANCORA = `
  create or replace function public.tv_snapshot_calcular() returns jsonb
   language sql stable as $f$
    select jsonb_build_object(
      'ranking_semana',
      (select count(*) from (values ('2026-10-02'::date)) t(data_pagamento)
        where data_pagamento >= current_date - 6),
      'ranking_mes',
      (select count(*) from (values ('2026-10-02'::date)) t(data_pagamento)
        where date_trunc('month', data_pagamento) = date_trunc('month', current_date))
    )
  $f$;
`;

const defDe = async (db) =>
  (await db.query(`
    select pg_get_functiondef(p.oid) d from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname='tv_snapshot_calcular'`)).rows[0].d;

describe("semana da TV — o patch é ancorado e não reescreve a função", () => {
  it("troca só a janela: ranking_mes e o resto do corpo ficam intactos", async () => {
    const db = await PGlite.create();
    await db.exec(FUNCAO_COM_ANCORA);
    const antes = await defDe(db);

    await db.exec(MIGRATION);
    const depois = await defDe(db);

    expect(antes).toContain(JANELA_VELHA);
    expect(depois).toContain(JANELA_NOVA);
    expect(depois).not.toContain(JANELA_VELHA);
    // o unico byte que muda e a janela: reaplicar a troca reconstroi o original
    expect(depois.replace(JANELA_NOVA, JANELA_VELHA)).toBe(antes);
    // a chave do mes nao foi tocada
    expect(depois).toContain("date_trunc('month', data_pagamento)");
    await db.close();
  });

  it("é idempotente: rodar de novo não muda nada", async () => {
    const db = await PGlite.create();
    await db.exec(FUNCAO_COM_ANCORA);
    await db.exec(MIGRATION);
    const primeira = await defDe(db);
    await db.exec(MIGRATION);
    expect(await defDe(db)).toBe(primeira);
    await db.close();
  });

  it("o rollback devolve a janela móvel, e também é idempotente", async () => {
    const db = await PGlite.create();
    await db.exec(FUNCAO_COM_ANCORA);
    const original = await defDe(db);

    await db.exec(MIGRATION);
    await db.exec(ROLLBACK);
    expect(await defDe(db)).toBe(original);

    await db.exec(ROLLBACK); // de novo: nao quebra
    expect(await defDe(db)).toBe(original);
    await db.close();
  });

  it("falha alto se a âncora não existir — não adivinha", async () => {
    const db = await PGlite.create();
    await db.exec(`
      create or replace function public.tv_snapshot_calcular() returns jsonb
       language sql stable as $f$ select '{}'::jsonb $f$;`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/esperava exatamente 1 ocorrencia/);
    await db.close();
  });

  it("falha alto se a âncora aparecer duas vezes", async () => {
    const db = await PGlite.create();
    await db.exec(`
      create or replace function public.tv_snapshot_calcular() returns jsonb
       language sql stable as $f$
        select jsonb_build_object(
          'a', (select count(*) from (values ('2026-10-02'::date)) t(data_pagamento)
                 where data_pagamento >= current_date - 6),
          'b', (select count(*) from (values ('2026-10-02'::date)) t(data_pagamento)
                 where data_pagamento >= current_date - 6))
       $f$;`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/encontrei 2/);
    await db.close();
  });

  it("falha alto se a função não existir", async () => {
    const db = await PGlite.create();
    await expect(db.exec(MIGRATION)).rejects.toThrow(/nao encontrada/);
    await db.close();
  });
});

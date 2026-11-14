// Teto acumulado da campanha: reserva atômica, sem renovação pela virada do dia
// e sem subir o teto. PGlite com o ambiente do recebimento. Sem chamada à ULBRA.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const sqlDe = (p) => readFileSync(p, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("\\")).join("\n");
const MIG = "supabase/aguardando_aprovacao/20261111130000_ulbra_sync_campanha.sql.pendente";
const ROLLBACK = "supabase/aguardando_aprovacao/20261111130000_ulbra_sync_campanha.rollback.sql";

async function ambiente() {
  const db = new PGlite();
  await db.exec(sqlDe("supabase/tests/ulbra_recebimento/01_ambiente.sql"));
  await db.exec(sqlDe("supabase/aguardando_aprovacao/20261108140000_ulbra_recebimento_e_fila.sql.pendente"));
  await db.exec(sqlDe(MIG));
  return db;
}
const reservar = async (db, c, teto, pedido) => (await db.query("select public.ulbra_sync_campanha_reservar($1,$2,$3) j", [c, teto, pedido])).rows[0].j;
const devolver = async (db, c, n) => (await db.query("select public.ulbra_sync_campanha_devolver($1,$2) j", [c, n])).rows[0].j;

describe("campanha: teto acumulado", () => {
  it("concede no máximo o restante; a soma das concessões nunca passa do teto", async () => {
    const db = await ambiente();
    const r1 = await reservar(db, "novembro-2026", 110, 12);
    expect(r1).toMatchObject({ ok: true, concedido: 12, reservadas: 12, restante: 98, teto: 110 });
    let total = 12;
    for (let i = 0; i < 20; i++) {
      const r = await reservar(db, "novembro-2026", 110, 12);
      total += r.concedido;
    }
    expect(total).toBe(110);
    const r = await reservar(db, "novembro-2026", 110, 12);
    expect(r.concedido).toBe(0);
    expect(r.restante).toBe(0);
    await db.close();
  });

  it("devolver libera só o não usado; o teto nunca sobe para a mesma campanha; dia novo não renova", async () => {
    const db = await ambiente();
    await reservar(db, "novembro-2026", 110, 12);
    const d = await devolver(db, "novembro-2026", 5); // usou 7 das 12
    expect(d).toMatchObject({ ok: true, reservadas: 7, restante: 103 });
    // pedir um teto maior não sobe o teto
    const r = await reservar(db, "novembro-2026", 500, 12);
    expect(r.teto).toBe(110);
    // "virada do dia": o contador do dia muda, a campanha não
    await db.query("update public.ulbra_sync_estado set dia = '2026-11-12', chamadas_dia = 0");
    const r2 = await reservar(db, "novembro-2026", 110, 12);
    expect(r2.reservadas).toBe(7 + 12 + 12);
    // devolver de outra campanha não mexe
    expect((await devolver(db, "outra", 100)).ok).toBe(false);
    await db.close();
  });

  it("pedido inválido é recusado; grants só service_role; rollback remove funções e colunas", async () => {
    const db = await ambiente();
    expect((await reservar(db, "", 110, 12)).motivo).toBe("PARAMETROS_INVALIDOS");
    expect((await reservar(db, "x", 0, 12)).motivo).toBe("PARAMETROS_INVALIDOS");
    const g = (await db.query("select grantee from information_schema.routine_privileges where routine_name like 'ulbra_sync_campanha_%' order by 1")).rows.map((r) => r.grantee);
    expect(g).not.toContain("authenticated"); expect(g).not.toContain("anon"); expect(g).toContain("service_role");
    await db.exec(sqlDe(ROLLBACK));
    expect((await db.query("select count(*)::int n from pg_proc where proname like 'ulbra_sync_campanha_%'")).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int n from information_schema.columns where table_name='ulbra_sync_estado' and column_name like 'campanha_%'")).rows[0].n).toBe(0);
    await db.close();
  });
});

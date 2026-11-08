// ULBRA — mapeamento operador ReATIVA x atendente ULBRA (20261108150000),
// executado num Postgres real (PGlite) nesta máquina e no CI.
//
// Roda as MESMAS etapas do job `ulbra-operadores-sql` do CI, na mesma ordem:
// ambiente -> migration candidata -> provas -> rollback -> verificação.
//
// Esta migration é SEPARADA do piloto `20261108140000` e NÃO está coberta pela
// autorização M1 da #864. O teste também não a aplica em lugar nenhum: PGlite
// é um banco descartável em memória.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const DIR = "supabase/tests/ulbra_operadores";
const MIGRATION = "supabase/aguardando_aprovacao/20261108150000_ulbra_operadores_vinculo.sql.pendente";
const ROLLBACK = "supabase/aguardando_aprovacao/20261108150000_ulbra_operadores_vinculo.rollback.sql";

function sqlDe(caminho) {
  return readFileSync(caminho, "utf8")
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("\\"))
    .join("\n");
}

describe("ULBRA mapeamento de operadores — Postgres real (PGlite)", () => {
  it("migration candidata, RLS, privilégios e rollback passam em sequência", async () => {
    const db = new PGlite();
    await db.exec(sqlDe(`${DIR}/01_ambiente.sql`));
    await db.exec(sqlDe(MIGRATION));
    await db.exec(sqlDe(`${DIR}/02_provas.sql`));
    await db.exec(sqlDe(ROLLBACK));
    await db.exec(sqlDe(`${DIR}/03_depois_do_rollback.sql`));
    await db.close();
    expect(true).toBe(true);
  }, 120_000);
});

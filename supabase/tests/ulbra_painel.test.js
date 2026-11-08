// ULBRA — painel da gestao (20261109090000), executado num Postgres real
// (PGlite) nesta máquina e no CI, sobre o MESMO ambiente e seed do recebimento.
//
// Ordem, igual ao job `ulbra-painel-sql` do CI:
//   ambiente (do recebimento) -> migration do piloto (ja aplicada em prod;
//   aqui so para o banco de teste ter as tabelas) -> seed -> migration do
//   painel -> provas -> rollback do painel -> verificacao.
//
// A migration do painel e SEPARADA e NAO esta coberta por linha M1 alguma.
// Nada aqui aplica coisa nenhuma: PGlite e descartavel em memoria.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const REC = "supabase/tests/ulbra_recebimento";
const DIR = "supabase/tests/ulbra_painel";
const PILOTO = "supabase/aguardando_aprovacao/20261108140000_ulbra_recebimento_e_fila.sql.pendente";
const PAINEL = "supabase/aguardando_aprovacao/20261109090000_ulbra_painel_gestao.sql.pendente";
const ROLLBACK = "supabase/aguardando_aprovacao/20261109090000_ulbra_painel_gestao.rollback.sql";

function sqlDe(caminho) {
  return readFileSync(caminho, "utf8")
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("\\"))
    .join("\n");
}

describe("ULBRA painel da gestao — Postgres real (PGlite)", () => {
  it("portao, agregados, estados do ciclo e rollback passam em sequência", async () => {
    const db = new PGlite();
    await db.exec(sqlDe(`${REC}/01_ambiente.sql`));
    await db.exec(sqlDe(PILOTO));
    await db.exec(sqlDe(`${REC}/02_dados.sql`));
    await db.exec(sqlDe(PAINEL));
    await db.exec(sqlDe(`${DIR}/02_provas_painel.sql`));
    await db.exec(sqlDe(ROLLBACK));
    await db.exec(sqlDe(`${DIR}/03_depois_do_rollback.sql`));
    await db.close();
    expect(true).toBe(true);
  }, 120_000);
});

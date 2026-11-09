// ULBRA — central do operador (20261109150000), executada num Postgres real
// (PGlite) nesta máquina e no CI, sobre o MESMO ambiente e seed do recebimento.
//
// Ordem, igual ao job `ulbra-central-sql` do CI:
//   ambiente -> piloto -> seed -> painel da gestão (já aplicados em prod; aqui
//   só para o banco de teste ter os objetos) -> complemento -> migration da
//   central -> provas de portão e ISOLAMENTO entre operadores -> rollback ->
//   verificação.
//
// A migration da central é SEPARADA e NÃO está coberta por linha M1 alguma.
// Nada aqui aplica coisa nenhuma: PGlite é descartável em memória.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const REC = "supabase/tests/ulbra_recebimento";
const DIR = "supabase/tests/ulbra_central";
const PILOTO = "supabase/aguardando_aprovacao/20261108140000_ulbra_recebimento_e_fila.sql.pendente";
const PAINEL = "supabase/aguardando_aprovacao/20261109090000_ulbra_painel_gestao.sql.pendente";
const CENTRAL = "supabase/aguardando_aprovacao/20261109150000_ulbra_central_operador.sql.pendente";
const ROLLBACK = "supabase/aguardando_aprovacao/20261109150000_ulbra_central_operador.rollback.sql";

function sqlDe(caminho) {
  return readFileSync(caminho, "utf8")
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("\\"))
    .join("\n");
}

describe("ULBRA central do operador — Postgres real (PGlite)", () => {
  it("portão, isolamento entre operadores, regras da fila e rollback passam em sequência", async () => {
    const db = new PGlite();
    await db.exec(sqlDe(`${REC}/01_ambiente.sql`));
    await db.exec(sqlDe(PILOTO));
    await db.exec(sqlDe(`${REC}/02_dados.sql`));
    await db.exec(sqlDe(PAINEL));
    await db.exec(sqlDe(`${DIR}/01_complemento.sql`));
    await db.exec(sqlDe(CENTRAL));
    await db.exec(sqlDe(`${DIR}/02_provas_central.sql`));
    await db.exec(sqlDe(ROLLBACK));
    await db.exec(sqlDe(`${DIR}/03_depois_do_rollback.sql`));
    await db.close();
    expect(true).toBe(true);
  }, 120_000);
});

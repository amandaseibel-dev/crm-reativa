// ULBRA — recebimento (etapa 1): leitura por usuário, grants e rollback,
// executados num Postgres real (PGlite) nesta máquina e no CI.
//
// Roda as MESMAS etapas do job `ulbra-recebimento-sql` do CI, na mesma ordem:
// ambiente -> migration candidata -> dados -> provas -> rollback -> verificação.
// As meta-instruções do psql (\set, \i) são removidas: PGlite não as entende.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const DIR = "supabase/tests/ulbra_recebimento";
const MIGRATION = "supabase/aguardando_aprovacao/20261108140000_ulbra_recebimento_e_fila.sql.pendente";
const ROLLBACK = "supabase/aguardando_aprovacao/20261108140000_ulbra_recebimento_e_fila.rollback.sql";

function sqlDe(caminho) {
  return readFileSync(caminho, "utf8")
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("\\"))
    .join("\n");
}

describe("ULBRA recebimento — Postgres real (PGlite)", () => {
  it("migration candidata, leitura por usuário, grants e rollback passam em sequência", async () => {
    const db = new PGlite();
    await db.exec(sqlDe(`${DIR}/01_ambiente.sql`));
    await db.exec(sqlDe(MIGRATION));
    await db.exec(sqlDe(`${DIR}/02_dados.sql`));
    // Cada afirmação falha alto com 'FALHOU: ...': exec() rejeita e o teste cai.
    await db.exec(sqlDe(`${DIR}/03_leitura_por_usuario.sql`));
    await db.exec(sqlDe(`${DIR}/05_resposta_seguida_de_operador.sql`));
    await db.exec(sqlDe(`${DIR}/06_fila_de_detalhes.sql`));
    await db.exec(sqlDe(`${DIR}/07_reabrir_pendencia.sql`));
    await db.exec(sqlDe(ROLLBACK));
    await db.exec(sqlDe(`${DIR}/04_depois_do_rollback.sql`));
    await db.close();
    expect(true).toBe(true);
  }, 120_000);
});

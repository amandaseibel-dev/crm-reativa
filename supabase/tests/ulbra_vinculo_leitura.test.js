// Prova da leitura do vinculo para a ficha, COM autorizacao sobre o aluno.
// Mesma sequencia do job ulbra-vinculo-leitura-sql do CI (Postgres 17).
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const sqlDe = (c) => readFileSync(c, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("\\")).join("\n");
it("ulbra_vinculo_aluno: autorizacao por aluno, perfis amplos, inativo, painel e anon", async () => {
  const db = new PGlite();
  const D = "supabase/tests/ulbra_vinculo_leitura";
  await db.exec(sqlDe(`${D}/00_ambiente.sql`));
  await db.exec(sqlDe(`${D}/01_montagem.sql`));
  await db.exec(sqlDe("supabase/aguardando_aprovacao/20261109180000_ulbra_vinculo_leitura.sql.pendente"));
  await db.exec(sqlDe(`${D}/02_provas.sql`));
  await db.close();
  expect(true).toBe(true);
}, 120000);

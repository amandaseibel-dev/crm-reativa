// Prova da leitura do vinculo para a ficha: so banco, status certo, sem vazamento.
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const sqlDe = (c) => readFileSync(c, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("\\")).join("\n");
it("ulbra_vinculo_aluno: status por caso, so para usuario ativo, sem link quando nao confirmado", async () => {
  const db = new PGlite();
  await db.exec(sqlDe("supabase/tests/ulbra_recebimento/01_ambiente.sql"));
  await db.exec(sqlDe("supabase/tests/ulbra_vinculo_leitura/01_leitura.sql"));
  await db.exec(sqlDe("supabase/aguardando_aprovacao/20261109170000_ulbra_vinculo_leitura.sql.pendente"));
  await db.exec(sqlDe("supabase/tests/ulbra_vinculo_leitura/02_provas.sql"));
  await db.close();
  expect(true).toBe(true);
}, 120000);

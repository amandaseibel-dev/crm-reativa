// Espelho em PGlite da sequência do job carteira-prioridade-sql do CI:
// ambiente -> dependências reais -> migration -> permissões. Pega erro de sintaxe
// e de semântica antes do CI. Não substitui o PostgreSQL real do CI.
import { it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARQUIVOS = [
  "supabase/tests/carteira_prioridade_bordero/01_ambiente.sql",
  "supabase/tests/fixtures/carteira_prioridade/dependencias_prod_20261118.sql",
  "supabase/migrations/20261117100000_carteira_prioridade_bordero.sql",
  "supabase/tests/carteira_prioridade_bordero/02_permissoes.sql",
];

it("sequência do CI roda do começo ao fim, incluindo permissões e lote de 1200 alunos", async () => {
  const db = new PGlite({ extensions: { unaccent } });
  for (const f of ARQUIVOS) {
    await db.exec(readFileSync(resolve(RAIZ, f), "utf8"));
  }
  expect(true).toBe(true);
}, 60000);

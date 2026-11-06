/**
 * Testes do validador AST do servidor MCP somente leitura.
 * Executa sem conexão ao banco — valida apenas a camada de proteção AST.
 * Importa a mesma lógica usada pelo servidor (validate.mjs).
 */

import { validarAST } from "./validate.mjs";

let ok = 0, fail = 0;

function deve_passar(label, sql) {
  try {
    validarAST(sql);
    console.log(`  PASS  ${label}`);
    ok++;
  } catch (e) {
    console.log(`  FAIL  ${label} — inesperadamente bloqueado: ${e.message}`);
    fail++;
  }
}

function deve_bloquear(label, sql) {
  try {
    validarAST(sql);
    console.log(`  FAIL  ${label} — deveria ter sido bloqueado`);
    fail++;
  } catch (e) {
    console.log(`  PASS  ${label} — bloqueado: ${e.message.slice(0, 80)}`);
    ok++;
  }
}

console.log("\n=== TESTES AST — servidor MCP somente leitura ===\n");

console.log("--- Leituras permitidas ---");
deve_passar("SELECT simples",
  "SELECT id, aluno_id FROM acordos LIMIT 10");
deve_passar("SELECT com JOIN",
  "SELECT a.id, p.valor FROM acordos a JOIN pagamentos p ON p.acordo_id = a.id");
deve_passar("SELECT com agregado count()",
  "SELECT count(*) FROM casos WHERE status = 'aberto'");
deve_passar("SELECT com sum() e date_trunc()",
  "SELECT date_trunc('month', created_at), sum(valor) FROM pagamentos GROUP BY 1");
deve_passar("SELECT com coalesce e lower",
  "SELECT coalesce(lower(nome), 'sem nome') FROM alunos");
deve_passar("SELECT com window function row_number",
  "SELECT row_number() OVER (ORDER BY id), id FROM acordos");
deve_passar("SELECT com subquery",
  "SELECT * FROM (SELECT id, valor FROM pagamentos WHERE valor > 0) sub");
deve_passar("SELECT com CTE",
  "WITH base AS (SELECT id FROM acordos) SELECT * FROM base");

console.log("\n--- Escritas bloqueadas ---");
deve_bloquear("INSERT",
  "INSERT INTO pagamentos (valor) VALUES (100)");
deve_bloquear("UPDATE",
  "UPDATE acordos SET status = 'cancelado' WHERE id = '1'");
deve_bloquear("DELETE",
  "DELETE FROM casos WHERE id = '1'");
deve_bloquear("TRUNCATE",
  "TRUNCATE TABLE pagamentos");
deve_bloquear("DROP TABLE",
  "DROP TABLE pagamentos");
deve_bloquear("CREATE TABLE",
  "CREATE TABLE hack (x text)");
deve_bloquear("ALTER TABLE",
  "ALTER TABLE acordos ADD COLUMN hack text");

console.log("\n--- Escrita dentro de CTE bloqueada ---");
deve_bloquear("CTE com INSERT",
  "WITH w AS (INSERT INTO pagamentos (valor) VALUES (1) RETURNING id) SELECT * FROM w");
deve_bloquear("CTE com UPDATE",
  "WITH w AS (UPDATE acordos SET status = 'x' RETURNING id) SELECT * FROM w");
deve_bloquear("CTE com DELETE",
  "WITH w AS (DELETE FROM casos RETURNING id) SELECT * FROM w");

console.log("\n--- Funções write bloqueadas ---");
deve_bloquear("caso_encerramento_resolver()",
  "SELECT caso_encerramento_resolver('a'::uuid, 'b', 'c')");
deve_bloquear("mensalidade_reconciliar_pago_sem_lastro()",
  "SELECT mensalidade_reconciliar_pago_sem_lastro(true)");
deve_bloquear("prime_conferencia_classificar_humano()",
  "SELECT prime_conferencia_classificar_humano('a'::uuid, 'b', 'c')");
deve_bloquear("prime_liquidacao_classificar_novas()",
  "SELECT prime_liquidacao_classificar_novas(10, false)");
deve_bloquear("titulo_reabrir_quitacao_por_acordo()",
  "SELECT titulo_reabrir_quitacao_por_acordo('a'::uuid)");
deve_bloquear("fila_receptivo_marcar_atendido()",
  "SELECT fila_receptivo_marcar_atendido('x', 'a'::uuid, 'b')");

console.log("\n--- Múltiplos statements bloqueados ---");
deve_bloquear("SELECT; SELECT",
  "SELECT 1; SELECT 2");
deve_bloquear("SELECT; INSERT",
  "SELECT id FROM acordos; INSERT INTO pagamentos VALUES (1)");

console.log("\n--- SET bloqueado ---");
deve_bloquear("SET transaction_read_only = off",
  "SET transaction_read_only = 'off'");
deve_bloquear("SET search_path",
  "SET search_path TO public, pg_catalog");

console.log("\n--- SQL malformado ---");
deve_bloquear("SQL vazio",
  "");
deve_bloquear("Apenas ponto-e-vírgula",
  ";");

console.log(`\n=== RESULTADO: ${ok} aprovados, ${fail} reprovados ===\n`);
process.exit(fail > 0 ? 1 : 0);

// Teste do rollback 20261110100000 (ulbra_historico_orcamento) em PGlite.
// Reproduz formas de execução: psql por instrução (sem begin, sem ON_ERROR_STOP,
// continua após erro) e arquivo dentro de transação com confirmação.
// Execução manual: node supabase/tests/ulbra_historico_rollback_orcamento/run.mjs
// (requer @electric-sql/pglite instalado; não roda no CI desta PR).
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const RB = path.resolve(aqui, "../../aguardando_aprovacao/20261110100000_ulbra_historico_orcamento.rollback.sql");
const rollback = fs.readFileSync(RB, "utf8");

// Divide por ';' fora de blocos $$ (como o psql faz ao ler um arquivo).
function instrucoes(texto) {
  const out = [];
  let atual = "";
  let dentroDolar = false;
  for (let k = 0; k < texto.length; k++) {
    if (texto.startsWith("$$", k)) { dentroDolar = !dentroDolar; atual += "$$"; k++; continue; }
    const c = texto[k];
    if (c === ";" && !dentroDolar) { atual += c; if (atual.replace(/--[^\n]*/g, "").trim() !== ";") out.push(atual.trim()); atual = ""; continue; }
    atual += c;
  }
  if (atual.replace(/--[^\n]*/g, "").trim()) out.push(atual.trim());
  return out.filter((x) => x.replace(/--[^\n]*/g, "").trim());
}

async function montar() {
  const db = new PGlite();
  await db.exec(`
    create table public.ulbra_historico_uso (escopo text, dia date, usadas int);
    create function public.ulbra_historico_reservar(text, date, integer, integer, integer) returns int
      language sql as $$ select 1 $$;
  `);
  return db;
}
async function estado(db) {
  const f = (await db.query("select count(*)::int n from pg_proc where proname='ulbra_historico_reservar'")).rows[0].n;
  const t = (await db.query("select count(*)::int n from pg_tables where tablename='ulbra_historico_uso'")).rows[0].n;
  return { funcao: f, tabela: t };
}

// psql sem ON_ERROR_STOP: cada instrução é autocommit e o erro não interrompe as seguintes.
async function psqlPorInstrucao(db, texto) {
  for (const sql of instrucoes(texto)) {
    try { await db.exec(sql); } catch { /* psql segue sem ON_ERROR_STOP */ }
  }
}

const casos = [];
const ok = (nome, cond, detalhe) => { casos.push({ nome, cond }); console.log((cond ? "PASSA " : "FALHA ") + nome + " " + JSON.stringify(detalhe)); };

// A: psql por instrução, sem begin, sem confirmação -> nada removido.
{ const db = await montar(); await psqlPorInstrucao(db, rollback); const e = await estado(db);
  ok("A psql sem begin, sem confirmação: nada removido", e.funcao === 1 && e.tabela === 1, e); }

// B: psql por instrução, com set local fora de transação (sem begin) -> set local não vale -> nada removido.
{ const db = await montar(); await psqlPorInstrucao(db, "set local app.confirma_retirada_ulbra_historico = 'sim';\n" + rollback);
  const e = await estado(db); ok("B confirmação sem begin: nada removido", e.funcao === 1 && e.tabela === 1, e); }

// C: begin + confirmação 'sim' -> removido.
{ const db = await montar(); await db.exec("begin; set local app.confirma_retirada_ulbra_historico = 'sim';\n" + rollback + "\ncommit;");
  const e = await estado(db); ok("C begin + 'sim': removido", e.funcao === 0 && e.tabela === 0, e); }

// D: begin + valor errado -> recusa, nada removido.
{ const db = await montar();
  try { await db.exec("begin; set local app.confirma_retirada_ulbra_historico = 'nao';\n" + rollback + "\ncommit;"); } catch { await db.exec("rollback").catch(() => {}); }
  const e = await estado(db); ok("D begin + valor errado: nada removido", e.funcao === 1 && e.tabela === 1, e); }

const falhas = casos.filter((c) => !c.cond).length;
console.log(falhas === 0 ? "TODOS OS CASOS PASSARAM (" + casos.length + ")" : falhas + " caso(s) falharam");
process.exit(falhas === 0 ? 0 : 1);

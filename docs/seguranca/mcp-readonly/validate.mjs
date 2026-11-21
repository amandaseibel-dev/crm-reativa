import { parse } from "pgsql-ast-parser";

export const STMT_ALLOW = new Set(["select", "with"]);

// "call" ausente intencionalmente: pgsql-ast-parser usa type "call" para
// chamadas de função no nível de expressão (count(), sum()…), não só para
// CALL proc(). O CALL proc() top-level já é rejeitado por STMT_ALLOW.
export const STMT_DENY = new Set([
  "insert","update","delete","truncate table","drop table","drop index",
  "drop schema","create table","create index","create schema","alter table",
  "alter index","set","do","notify","listen","unlisten","vacuum","reindex",
]);

export const FN_ALLOW = new Set([
  "count","sum","min","max","avg","coalesce","nullif","greatest","least",
  "now","current_timestamp","current_date","date_trunc","date_part",
  "extract","to_char","to_date","to_timestamp","age","round","ceil",
  "floor","abs","length","substr","trim","lower","upper","replace",
  "concat","concat_ws","array_agg","json_agg","jsonb_agg",
  "string_agg","bool_and","bool_or","every",
  "row_number","rank","dense_rank","lag","lead","first_value","last_value",
]);

export function validarAST(sql) {
  let stmts;
  try { stmts = parse(sql, { locationTracking: false }); }
  catch (e) { throw new Error(`SQL inválido: ${e.message}`); }
  if (stmts.length === 0) throw new Error("SQL vazio.");
  if (stmts.length > 1) throw new Error("Múltiplos statements não permitidos.");
  const stmt = stmts[0];
  const tipo = stmt.type?.toLowerCase();
  if (!STMT_ALLOW.has(tipo))
    throw new Error(`Statement '${tipo || "desconhecido"}' não permitido. Apenas SELECT.`);
  verificarNos(stmt);
}

function verificarNos(no) {
  if (!no || typeof no !== "object") return;
  if (no.type && STMT_DENY.has(no.type.toLowerCase()))
    throw new Error(`Statement '${no.type}' bloqueado dentro de CTE ou subquery.`);
  if (no.type === "call" || no.type === "call expression") {
    const nome = (no.function?.name || no.name || "").toLowerCase();
    if (nome && !FN_ALLOW.has(nome))
      throw new Error(`Chamada de função '${nome}' bloqueada. Use apenas funções de leitura/agregação.`);
  }
  for (const val of Object.values(no)) {
    if (Array.isArray(val)) val.forEach(verificarNos);
    else if (val && typeof val === "object") verificarNos(val);
  }
}

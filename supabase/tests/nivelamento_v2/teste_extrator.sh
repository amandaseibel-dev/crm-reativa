#!/usr/bin/env bash
# TESTE DO EXTRATOR contra Postgres REAL (CI, banco sintetico). Nunca toca producao.
# Pre-requisitos: banco 'integracao' ja carregado com o fixture; papel leitor_defs com
# privilegios minimos; driver pg em $PG_DRIVER; PGHOST/PGPORT/PGUSER/PGPASSWORD do CI.
set -uo pipefail
D=supabase/tests/nivelamento_v2
FINAL="$D/prod_defs.json"
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT
FALHAS=0
ok()   { echo "OK   $1"; }
nok()  { echo "FAIL $1"; FALHAS=$((FALHAS+1)); }
hash_arq() { if [ -f "$1" ]; then if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; else echo "AUSENTE"; fi; }
URL_OK="postgres://leitor_defs:ci-sintetico-unico@localhost:5432/integracao"

# 1) sucesso com papel de privilegio minimo
rm -f "$FINAL"
PROD_READONLY_URL="$URL_OK" node "$D/extrair_prod_defs.mjs" >"$TMPD/a.log" 2>&1; rc=$?
[ $rc -eq 0 ] && [ -f "$FINAL" ] && ok "sucesso com papel leitor_defs (rc=$rc)" || { nok "sucesso (rc=$rc)"; cat "$TMPD/a.log"; }
REF=$(hash_arq "$FINAL")

# 2) falha de conexao: arquivo anterior preservado
PROD_READONLY_URL="postgres://leitor_defs:ci-sintetico-unico@localhost:1/integracao" \
  node "$D/extrair_prod_defs.mjs" >"$TMPD/b.log" 2>&1; rc=$?
[ $rc -ne 0 ] && [ "$(hash_arq "$FINAL")" = "$REF" ] && ! ls "$FINAL".tmp-* >/dev/null 2>&1 \
  && ok "falha de conexao: rc=$rc, arquivo anterior preservado, sem temporario" \
  || { nok "falha de conexao (rc=$rc)"; cat "$TMPD/b.log"; }

# 3) divergencia de hash: export adulterado (sha de uma funcao trocado)
node -e '
const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
j.funcoes[0].sha256 = "0".repeat(64);
fs.writeFileSync(process.argv[2], "select $j$" + JSON.stringify(j) + "$j$;\n");' "$D/fixtures/prod_defs_sintetico.json" "$TMPD/tamper.sql"
PROD_READONLY_URL="$URL_OK" EXPORT_SQL="$TMPD/tamper.sql" node "$D/extrair_prod_defs.mjs" >"$TMPD/c.log" 2>&1; rc=$?
[ $rc -ne 0 ] && [ "$(hash_arq "$FINAL")" = "$REF" ] && grep -q "HASH DIVERGENTE" "$TMPD/c.log" \
  && ok "divergencia de hash recusada, arquivo anterior preservado (rc=$rc)" \
  || { nok "divergencia de hash (rc=$rc)"; cat "$TMPD/c.log"; }

# 4) sem URL: nada alterado
env -u PROD_READONLY_URL node "$D/extrair_prod_defs.mjs" >"$TMPD/d.log" 2>&1; rc=$?
[ $rc -eq 3 ] && [ "$(hash_arq "$FINAL")" = "$REF" ] && ok "sem URL: rc=3, arquivo preservado" || nok "sem URL (rc=$rc)"

# 5) privilegio minimo: o papel NAO le dados de tabela
if PGPASSWORD=ci-sintetico-unico psql -h localhost -U leitor_defs -d integracao -X -q -At -c "select count(*) from public.casos" >/dev/null 2>"$TMPD/e.log"; then
  nok "papel leitor_defs leu dados de public.casos (privilegio excessivo)"
else
  grep -q "permission denied" "$TMPD/e.log" && ok "papel leitor_defs sem acesso a dados (permission denied)" || { nok "erro inesperado no teste de privilegio"; cat "$TMPD/e.log"; }
fi

echo "---"
[ "$FALHAS" -eq 0 ] && echo "EXTRATOR: todos os cenarios OK" || { echo "EXTRATOR: $FALHAS falha(s)"; exit 1; }

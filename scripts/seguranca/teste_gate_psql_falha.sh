#!/usr/bin/env bash
# ============================================================================
# Prova do defeito de run_security_gate.sh: quando o psql FALHA, o gate imprime
# "SQL OK" e sai com codigo 0. Nao toca em nenhum banco: usa um psql falso que
# reproduz a falha observada em 14/11/2026 (ORDER BY com expressao sobre UNION,
# SQLSTATE 0A000).
#
# Uso:  scripts/seguranca/teste_gate_psql_falha.sh
# Esperado: a linha "SQL OK" aparece e EXIT=0. Se isso mudar, o defeito foi
# corrigido e este teste deve ser atualizado.
# ============================================================================
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
FAKE="$(mktemp -d)"
trap 'rm -rf "$FAKE"' EXIT
cat > "$FAKE/psql" <<'PSQL'
#!/usr/bin/env bash
echo "ERROR:  0A000: invalid UNION/INTERSECT/EXCEPT ORDER BY clause" >&2
exit 1
PSQL
chmod +x "$FAKE/psql"
PATH="$FAKE:$PATH" DATABASE_URL="postgres://fake@localhost/fake" "$ROOT/scripts/seguranca/run_security_gate.sh" > "$FAKE/saida.txt" 2>&1
code=$?
cat "$FAKE/saida.txt"
echo "EXIT=$code"
grep -q "SQL OK" "$FAKE/saida.txt" && [ "$code" -eq 0 ] && echo "DEFEITO REPRODUZIDO: gate aprovou sem auditar."

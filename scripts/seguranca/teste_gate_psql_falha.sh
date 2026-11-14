#!/usr/bin/env bash
# ============================================================================
# Prova reproduzível: quando a auditoria SQL NAO roda, o gate REPROVA.
# Nao toca em nenhum banco: usa um psql falso em duas variantes.
#   A) psql sai com 1 (falha fatal)
#   B) psql sai com 0 mas imprime "ERROR:" (comportamento padrao do psql -f
#      sem ON_ERROR_STOP, que o gate antigo deixava passar)
# Esperado nas duas: REPROVADO, EXIT=1, e NENHUMA linha "SQL OK".
# Uso: scripts/seguranca/teste_gate_psql_falha.sh
# ============================================================================
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
ok=0; falhou=0

rodar() {  # $1 = nome da variante, $2 = corpo do psql falso, $3 = rc do psql falso
  local FAKE; FAKE="$(mktemp -d)"
  printf '#!/usr/bin/env bash\n%s\nexit %s\n' "$2" "$3" > "$FAKE/psql"
  chmod +x "$FAKE/psql"
  local saida code
  saida="$(PATH="$FAKE:$PATH" DATABASE_URL="postgres://fake@localhost/fake" "$ROOT/scripts/seguranca/run_security_gate.sh" 2>&1)"
  code=$?
  rm -rf "$FAKE"
  echo "--- $1 (EXIT=$code)"
  echo "$saida" | grep -E "REPROVADO|SQL OK|APROVADO" | sed 's/^/    /'
  if [[ "$code" -ne 0 ]] && ! grep -q "SQL OK" <<<"$saida"; then
    echo "    OK: gate reprovou sem auditar."; ok=$((ok+1))
  else
    echo "    FALHA: o gate aprovou ou saiu com 0 sem auditar."; falhou=$((falhou+1))
  fi
}

rodar "A: psql falha (rc=1)" 'echo "ERROR:  0A000: invalid UNION/INTERSECT/EXCEPT ORDER BY clause" >&2' 1
rodar "B: psql rc=0 com ERROR na saida" 'echo "ERROR:  0A000: invalid UNION/INTERSECT/EXCEPT ORDER BY clause"' 0

echo
if [[ "$falhou" -eq 0 ]]; then echo "TESTE OK: $ok/2 variantes reprovam sem auditar."; exit 0
else echo "TESTE FALHOU: $falhou variante(s) aprovaram sem auditar."; exit 1; fi

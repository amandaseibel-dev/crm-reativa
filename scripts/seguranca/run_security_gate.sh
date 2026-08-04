#!/usr/bin/env bash
# ============================================================================
# Security Gate — CRM ReATIVA
# Roda a auditoria de segurança (SQL) contra o banco alvo e FALHA (exit != 0)
# quando houver achado de gravidade BLOQUEIA. Use antes de todo deploy/merge.
#
# Uso:
#   DATABASE_URL="postgres://...:5432/postgres" scripts/seguranca/run_security_gate.sh
#   (ou)  scripts/seguranca/run_security_gate.sh "postgres://..."
#
# Também executa checagens do bundle (grep) quando houver dist/ ou src/.
# Documente exceções técnicas em docs/seguranca/ — exceção NÃO é aprovação.
# ============================================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
SQL="$DIR/auditoria_seguranca.sql"
DB="${1:-${DATABASE_URL:-}}"

fail=0

echo "== Security Gate: auditoria SQL =="
if [[ -z "$DB" ]]; then
  echo "ERRO: informe DATABASE_URL (ou 1º argumento) apontando para o banco alvo." >&2
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "ERRO: psql não encontrado no PATH." >&2
  exit 2
fi

# Executa o script e captura as linhas de achado.
OUT="$(psql "$DB" -X -A -F $'\t' -t -f "$SQL" 2>&1)"
echo "$OUT"

if grep -q "BLOQUEIA" <<<"$OUT"; then
  echo ">> REPROVADO: há achados de gravidade BLOQUEIA." >&2
  fail=1
else
  echo ">> SQL OK: nenhum achado BLOQUEIA."
fi

echo
echo "== Checagens do bundle/repo =="
# service_role no código do cliente
if grep -rniE "service_role|SERVICE_ROLE" "$ROOT/src" 2>/dev/null | grep -v "process.env" | grep -qiE "eyJ|createClient\("; then
  echo ">> REPROVADO: possível service_role no código do cliente." >&2; fail=1
else echo "service_role no cliente: OK"; fi
# ref de staging no bundle de produção
if [[ -d "$ROOT/dist" ]] && grep -rq "edlzlfba" "$ROOT/dist" 2>/dev/null; then
  echo ">> REPROVADO: referência ao Supabase de staging no bundle dist/." >&2; fail=1
else echo "staging no bundle: OK"; fi
# JWT/segredo hardcoded no cliente
if grep -rnoE "eyJ[A-Za-z0-9_-]{30,}" "$ROOT/src" 2>/dev/null | grep -q .; then
  echo ">> REPROVADO: token/JWT hardcoded em src/." >&2; fail=1
else echo "segredo hardcoded: OK"; fi

echo
if [[ "$fail" -ne 0 ]]; then
  echo "SECURITY GATE: ⚠ REPROVADO"; exit 1
fi
echo "SECURITY GATE: ☑ APROVADO"; exit 0

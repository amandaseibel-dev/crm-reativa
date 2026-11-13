#!/usr/bin/env bash
# Teto atômico do piloto em Postgres isolado: 8 reservas em paralelo, com o SQL REAL
# da migração pendente. Com teto global 3, exatamente 3 podem ser permitidas, e o
# contador do banco fica em 3. Não chama a ULBRA; não usa nada de produção.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
psql -v ON_ERROR_STOP=1 -q -c "create role anon nologin; create role authenticated nologin; create role service_role nologin;"
psql -v ON_ERROR_STOP=1 -q -f "$DIR/migracao.sql"
TMP="$(mktemp -d)"
for i in $(seq 1 8); do
  psql -At -v ON_ERROR_STOP=1 -c "select permitido from public.ulbra_historico_reservar('operador$i@teste.local', current_date, 1, 20, 3)" > "$TMP/r$i.txt" &
done
wait
APROVADAS=$(cat "$TMP"/r*.txt | grep -c '^t$' || true)
NEGADAS=$(cat "$TMP"/r*.txt | grep -c '^f$' || true)
USADO=$(psql -At -c "select coalesce(sum(usadas),0) from public.ulbra_historico_uso where escopo='*'")
echo "aprovadas=$APROVADAS negadas=$NEGADAS usado_global=$USADO"
test "$APROVADAS" = "3"
test "$NEGADAS" = "5"
test "$USADO" = "3"
echo "OK: teto atômico com 8 reservas simultâneas"

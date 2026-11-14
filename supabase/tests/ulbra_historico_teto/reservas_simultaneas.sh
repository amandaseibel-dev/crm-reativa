#!/usr/bin/env bash
# Orçamento do histórico em Postgres isolado, com o SQL REAL da migração pendente e
# reservas SIMULTÂNEAS. Dois casos: limite por usuário (um operador, 6 cliques) e
# orçamento compartilhado (8 operadores, 8 cliques). Não chama a ULBRA.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
psql -v ON_ERROR_STOP=1 -q -c "create role anon nologin; create role authenticated nologin; create role service_role nologin;"
psql -v ON_ERROR_STOP=1 -q -f "$DIR/migracao.sql"
TMP="$(mktemp -d)"

# Caso 1: limite por usuário = 3, compartilhado = 100. Um operador, 6 cliques.
for i in $(seq 1 6); do
  psql -At -v ON_ERROR_STOP=1 -c "select permitido from public.ulbra_historico_reservar('mesmo@teste.local', current_date, 1, 3, 100)" > "$TMP/u$i.txt" &
done
wait
U_OK=$(cat "$TMP"/u*.txt | grep -c '^t$' || true)
U_NEG=$(cat "$TMP"/u*.txt | grep -c '^f$' || true)
echo "limite_por_usuario: aprovadas=$U_OK negadas=$U_NEG"
test "$U_OK" = "3"
test "$U_NEG" = "3"

# Caso 2: compartilhado = 3, limite por usuário = 20. Oito operadores distintos, 8 cliques.
psql -v ON_ERROR_STOP=1 -q -c "delete from public.ulbra_historico_uso;"
for i in $(seq 1 8); do
  psql -At -v ON_ERROR_STOP=1 -c "select permitido from public.ulbra_historico_reservar('operador$i@teste.local', current_date, 1, 20, 3)" > "$TMP/g$i.txt" &
done
wait
G_OK=$(cat "$TMP"/g*.txt | grep -c '^t$' || true)
G_NEG=$(cat "$TMP"/g*.txt | grep -c '^f$' || true)
USADO=$(psql -At -c "select coalesce(sum(usadas),0) from public.ulbra_historico_uso where escopo='*'")
echo "compartilhado: aprovadas=$G_OK negadas=$G_NEG usado_global=$USADO"
test "$G_OK" = "3"
test "$G_NEG" = "5"
test "$USADO" = "3"
echo "OK: limite por usuário e orçamento compartilhado, com reservas simultâneas"

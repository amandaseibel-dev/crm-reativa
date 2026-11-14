#!/usr/bin/env bash
# Duas conexoes reais contra Postgres descartavel (CI). Nao usa producao.
# Cenario A: com historico. Captura iniciada antes do lock; rollback espera o lock;
#            captura concorrente espera o lock. Historico confirmado precisa sobreviver.
# Cenario B: sem historico. Leitor segura o lock; rollback espera; captura concorrente
#            precisa FALHAR (sem exclusao silenciosa de historico).
set -euo pipefail
DIR="${DIR:?}"
MIG="${MIG:?}"
RB="${RB:?}"
TMP="$(mktemp -d)"

q() { psql -X -v ON_ERROR_STOP=1 -tA -c "$1"; }

espera() {
  local i=0
  until [ "$(q "$1")" = "t" ]; do
    i=$((i + 1))
    if [ "$i" -gt 300 ]; then echo "timeout esperando: $1"; exit 1; fi
    sleep 0.1
  done
}

zera() {
  q "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS auth CASCADE;"
  psql -X -v ON_ERROR_STOP=1 -q -f "$DIR/01_ambiente.sql"
  psql -X -v ON_ERROR_STOP=1 -q -f "$MIG"
}

falha() { echo "FALHA: $1"; exit 1; }

echo "== Cenario A: com historico =="
zera
q "INSERT INTO relatorio_mens_2026_2_snapshot (dia, cpfs, alunos, mensalidades, saldo) VALUES ('2026-11-01', 1, 1, 1, 1);"

PGAPPNAME=captura_antes psql -X -v ON_ERROR_STOP=1 -q -c "BEGIN; SET app.role = 'service_role'; SELECT relatorio_mensalidades_2026_2_capturar(); SELECT pg_sleep(4); COMMIT;" > "$TMP/a1.out" 2>&1 &
P1=$!
espera "SELECT count(*) = 1 FROM pg_stat_activity WHERE application_name = 'captura_antes' AND state = 'active' AND query LIKE '%pg_sleep%'"

PGAPPNAME=rollback_a psql -X -v ON_ERROR_STOP=1 -q -f "$RB" > "$TMP/a2.out" 2>&1 &
P2=$!
espera "SELECT count(*) = 1 FROM pg_stat_activity WHERE application_name = 'rollback_a' AND wait_event_type = 'Lock'"

PGAPPNAME=captura_concorrente psql -X -v ON_ERROR_STOP=1 -q -c "SET app.role = 'service_role'; SELECT relatorio_mensalidades_2026_2_capturar();" > "$TMP/a3.out" 2>&1 &
P3=$!
espera "SELECT count(*) = 1 FROM pg_stat_activity WHERE application_name = 'captura_concorrente' AND wait_event_type = 'Lock'"

set +e
wait "$P1"; R1=$?
wait "$P2"; R2=$?
wait "$P3"; R3=$?
set -e
echo "captura_antes=$R1 rollback=$R2 captura_concorrente=$R3"
[ "$R1" -eq 0 ] || falha "captura iniciada antes do lock deveria concluir"
[ "$R2" -eq 0 ] || { cat "$TMP/a2.out"; falha "rollback com historico deveria concluir"; }

[ "$(q "SELECT to_regclass('public.relatorio_mens_2026_2_snapshot') IS NOT NULL")" = "t" ] || falha "tabela de snapshot foi apagada com historico"
[ "$(q "SELECT count(*) FROM relatorio_mens_2026_2_snapshot WHERE dia = '2026-11-01'")" = "1" ] || falha "snapshot confirmado foi perdido"
[ "$(q "SELECT count(*) FROM relatorio_mens_2026_2_snapshot")" -ge 2 ] || falha "captura confirmada antes do lock foi perdida"
[ "$(q "SELECT count(*) FROM pg_proc WHERE proname LIKE 'relatorio_mensalidades_2026_2%'")" = "0" ] || falha "funcoes nao foram removidas"
echo "historico preservado: $(q "SELECT count(*) FROM relatorio_mens_2026_2_snapshot") linha(s)"

psql -X -v ON_ERROR_STOP=1 -q -f "$MIG"
[ "$(q "SELECT count(*) FROM relatorio_mens_2026_2_snapshot WHERE dia = '2026-11-01'")" = "1" ] || falha "reinstalacao perdeu o snapshot"
echo "reinstalacao preservou o historico"

echo "== Cenario B: sem historico =="
zera

PGAPPNAME=leitor_segura psql -X -v ON_ERROR_STOP=1 -q -c "BEGIN; LOCK TABLE public.relatorio_mens_2026_2_snapshot IN ACCESS SHARE MODE; SELECT pg_sleep(4); COMMIT;" > "$TMP/b1.out" 2>&1 &
P1=$!
espera "SELECT count(*) = 1 FROM pg_stat_activity WHERE application_name = 'leitor_segura' AND state = 'active' AND query LIKE '%pg_sleep%'"

PGAPPNAME=rollback_b psql -X -v ON_ERROR_STOP=1 -q -f "$RB" > "$TMP/b2.out" 2>&1 &
P2=$!
espera "SELECT count(*) = 1 FROM pg_stat_activity WHERE application_name = 'rollback_b' AND wait_event_type = 'Lock'"

PGAPPNAME=captura_concorrente_b psql -X -v ON_ERROR_STOP=1 -q -c "SET app.role = 'service_role'; SELECT relatorio_mensalidades_2026_2_capturar();" > "$TMP/b3.out" 2>&1 &
P3=$!
espera "SELECT count(*) = 1 FROM pg_stat_activity WHERE application_name = 'captura_concorrente_b' AND wait_event_type = 'Lock'"

set +e
wait "$P1"; R1=$?
wait "$P2"; R2=$?
wait "$P3"; R3=$?
set -e
echo "leitor=$R1 rollback=$R2 captura_concorrente=$R3"
[ "$R1" -eq 0 ] || falha "leitor deveria concluir"
[ "$R2" -eq 0 ] || { cat "$TMP/b2.out"; falha "rollback sem historico deveria concluir"; }
[ "$R3" -ne 0 ] || falha "captura concorrente sem tabela deveria falhar, nao gravar em silencio"
grep -q "does not exist" "$TMP/b3.out" || { cat "$TMP/b3.out"; falha "falha da captura concorrente deveria ser 'does not exist'"; }
[ "$(q "SELECT to_regclass('public.relatorio_mens_2026_2_snapshot') IS NULL")" = "t" ] || falha "tabela deveria ter sido removida sem historico"
[ "$(q "SELECT count(*) FROM pg_proc WHERE proname LIKE 'relatorio_mensalidades_2026_2%'")" = "0" ] || falha "funcoes nao foram removidas"

echo "OK: rollback concorrente e reinstalacao validados em Postgres real"

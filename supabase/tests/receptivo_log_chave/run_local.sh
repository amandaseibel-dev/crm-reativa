#!/bin/bash
# Roda a suite da chave do log receptivo em um Postgres 16 ISOLADO (localhost).
# Uso: PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=... ./run_local.sh
# Ordem: ambiente -> antes -> migration -> casos -> corrida (2 conexoes) -> rollback -> conferencia.
set -euo pipefail
cd "$(dirname "$0")/../../.."
D=supabase/tests/receptivo_log_chave
M=supabase/aguardando_aprovacao/20261112100000_receptivo_log_chave_conversa.sql.pendente
R=supabase/aguardando_aprovacao/20261112100000_receptivo_log_chave_conversa.rollback.sql
export PGDATABASE=${PGDATABASE:-teste}
psql -q -d postgres -c "drop database if exists $PGDATABASE;" -c "create database $PGDATABASE;"
echo "== 01 ambiente";  psql -v ON_ERROR_STOP=1 -q -f $D/01_ambiente.sql
echo "== 02 antes (prova a perda com a chave antiga)"; psql -v ON_ERROR_STOP=1 -f $D/02_antes_migracao.sql
echo "== migration (transacao unica)"; psql -v ON_ERROR_STOP=1 -f $M
echo "== 03 casos"; psql -v ON_ERROR_STOP=1 -f $D/03_casos_migracao.sql
echo "== 04 corrida: duas conexoes na MESMA conversa/ciclo e em conversas DIFERENTES"
psql -v ON_ERROR_STOP=1 -q -f $D/04_concorrencia_setup.sql
psql -v ON_ERROR_STOP=1 -q -c "begin; select public.fila_receptivo_registrar_atendimento('op_a@test.local','00000000-0000-0000-0000-00000000f001'); select pg_sleep(3); commit;" &
A=$!; sleep 1
set +e; B_OUT=$(psql -v ON_ERROR_STOP=1 -tAc "select public.fila_receptivo_registrar_atendimento('op_a@test.local','00000000-0000-0000-0000-00000000f001');" 2>&1); B_RC=$?; set -e
wait $A
MESMA=$(psql -tAc "select count(*) from public.receptivo_atendimentos_log where conversa_id='00000000-0000-0000-0000-00000000f001'")
echo "mesma conversa, duas conexoes: B rc=$B_RC retorno=$B_OUT linhas=$MESMA"
[ "$MESMA" = "1" ] || { echo "FALHOU: mesma conversa contou $MESMA"; exit 1; }
psql -v ON_ERROR_STOP=1 -q -c "begin; select public.fila_receptivo_registrar_atendimento('op_a@test.local','00000000-0000-0000-0000-00000000f002'); select pg_sleep(3); commit;" &
A=$!; sleep 1
psql -v ON_ERROR_STOP=1 -q -c "select public.fila_receptivo_registrar_atendimento('op_a@test.local','00000000-0000-0000-0000-00000000f003');"
wait $A
DIFERENTES=$(psql -tAc "select count(*) from public.receptivo_atendimentos_log where conversa_id in ('00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000f003')")
echo "conversas diferentes, duas conexoes: linhas=$DIFERENTES"
[ "$DIFERENTES" = "2" ] || { echo "FALHOU: conversas diferentes contaram $DIFERENTES"; exit 1; }
# Fase A: rollback com duplicidade (criada pelos casos) DEVE ser recusado, sem apagar nada
echo "== rollback com duplicidade nova: deve ser RECUSADO"
set +e; RB_OUT=$(psql -v ON_ERROR_STOP=1 -f $R 2>&1); RB_RC=$?; set -e
echo "$RB_OUT" | grep -i "recusado" | head -2
[ "$RB_RC" -ne 0 ] || { echo "FALHOU: rollback aplicou com duplicidade"; exit 1; }
PRESERVA=$(psql -tAc "select count(*) from public.receptivo_atendimentos_log")
echo "rollback recusado (rc=$RB_RC); linhas preservadas=$PRESERVA"
psql -tAc "select count(*) from pg_indexes where tablename='receptivo_atendimentos_log' and indexname='uq_receptivo_log_operador_conversa_ciclo'" | grep -q "^1$" \
  || { echo "FALHOU: recusa deixou o estado mudado"; exit 1; }
# Fase B: banco limpo, sem duplicidade -> rollback aplica e a conferencia prova
echo "== fase B: banco limpo, migration + rollback + conferencia"
psql -q -d postgres -c "drop database if exists ${PGDATABASE}_rb;" -c "create database ${PGDATABASE}_rb;"
export PGDATABASE=${PGDATABASE}_rb
psql -v ON_ERROR_STOP=1 -q -f $D/01_ambiente.sql
psql -v ON_ERROR_STOP=1 -f $D/02_antes_migracao.sql >/dev/null
psql -v ON_ERROR_STOP=1 -q -f $M
psql -v ON_ERROR_STOP=1 -f $R
psql -v ON_ERROR_STOP=1 -f $D/05_rollback_conferencia.sql
echo "== FIM OK"

#!/usr/bin/env bash
# CONCORRÊNCIA COM DUAS CONEXÕES DE VERDADE.
#
# O PGlite tem uma conexão só: `for update` e `skip locked` nunca disputam nada
# lá. Aqui são dois `psql` simultâneos contra o mesmo Postgres -- é o único
# jeito de provar que duas abas não furam o teto.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LOTE=10000000-0000-4000-8000-000000000001

psql -v ON_ERROR_STOP=1 -q -f "$DIR/01_ambiente.sql"
for m in "$DIR"/../../migrations/20260929114757_prime_academico_piloto.sql \
         "$DIR"/../../migrations/20260929130000_piloto_reserva_orcamento_reconciliacao.sql \
         "$DIR"/../../migrations/20260929140000_piloto_execucao_unica_e_gasto_preservado.sql \
         "$DIR"/../../migrations/20260929150000_piloto_autorizacao_por_pagina.sql; do
  psql -v ON_ERROR_STOP=1 -q -f "$m"
done
psql -v ON_ERROR_STOP=1 -q -f "$DIR/02_dados.sql"

falhou=0
checar() { # nome, obtido, esperado
  if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FALHA $1: obtido='$2' esperado='$3'"; falhou=1; fi
}
q() { psql -tA -c "$1"; }

echo "== 1. duas sessoes pedem execucao ao mesmo tempo: so uma leva =="
EXEC_A=$(q "select public.prime_academico_piloto_iniciar('$LOTE')->>'execucao_id'")
B_OK=$(q "select public.prime_academico_piloto_iniciar('$LOTE')->>'ok'")
checar "a primeira leva a execucao" "$([ -n "$EXEC_A" ] && echo sim || echo nao)" "sim"
checar "a segunda e recusada" "$B_OK" "false"

echo "== 2. item reservado: a outra sessao nao recebe outro =="
ITEM=$(q "select public.prime_academico_piloto_proximo('$LOTE','$EXEC_A')->>'item_id'")
ALUNO=$(q "select aluno_id from public.prime_academico_piloto_item where id='$ITEM'")
SEG=$(q "select public.prime_academico_piloto_proximo('$LOTE','$EXEC_A')->>'motivo'")
checar "um item por vez no lote" "$SEG" "ja existe consulta em andamento neste lote"

echo "== 3. DUAS AUTORIZACOES SIMULTANEAS com 3 de teto =="
# as duas sessoes disparam ao mesmo tempo; `for update` no lote serializa,
# entao a soma nunca deixa passar mais do que o teto.
for i in 1 2 3 4 5; do
  psql -tA -c "select public.prime_academico_piloto_autorizar_pagina('$ITEM','$ALUNO','$EXEC_A')->>'ok'" &
done > /tmp/autoriza.txt
wait
OKS=$(grep -c '^t$' /tmp/autoriza.txt || true)
GASTAS=$(q "select public.prime_academico_piloto_gastas('$LOTE')")
checar "so 3 autorizacoes passam (teto)" "$OKS" "3"
checar "gasto contabilizado = teto"      "$GASTAS" "3"

echo "== 4. execucao superada nao fecha item =="
q "update public.prime_academico_piloto_lote set execucao_id=gen_random_uuid() where id='$LOTE'" >/dev/null
REC=$(q "select public.prime_academico_piloto_registrar('$ITEM',null,1,200,null,'$ALUNO','$EXEC_A')->>'recusado'")
checar "registro de execucao velha e recusado" "$REC" "true"
ESTADO=$(q "select estado from public.prime_academico_piloto_item where id='$ITEM'")
checar "item segue em processamento"           "$ESTADO" "EM_PROCESSAMENTO"

echo "== 5. reconciliar exige gestao =="
NEG=$(psql -tA -c "begin; set local teste.gestao='off'; set local teste.role='authenticated';
                   select public.prime_academico_piloto_reconciliar('$LOTE'); commit;" 2>&1 \
        | grep -c "Acesso negado" || true)
checar "authenticated sem gestao e recusado" "$NEG" "1"

[ "$falhou" = "0" ] && echo "TODOS OS CASOS PASSARAM" || { echo "HOUVE FALHA"; exit 1; }

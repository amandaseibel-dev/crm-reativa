#!/usr/bin/env bash
# Teste de CONCORRENCIA das reversoes (20261113100000 / 20261113100100) com conexoes psql
# independentes. SOMENTE em banco de TESTE recem-criado, com as duas migrations aplicadas
# na ordem (100100 antes de 100000). Nunca producao.
#   PG_URL=postgres://... scripts/ci/teste-reversao-concorrencia.sh
# NAO EXECUTADO no ambiente local (sem PostgreSQL). Status: pendente.
# Cada cenario exige o resultado esperado: recusa (erro) ou conclusao (sucesso).
set -euo pipefail
: "${PG_URL:?defina PG_URL apontando para um banco de TESTE}"
D=supabase/aguardando_aprovacao
RB_CONF="$D/20261113100000_acoes_massivas_confirmar_envio.rollback.sql"
RB_PROT="$D/20261113100100_acoes_massivas_email_so_apos_tabulacao.rollback.sql"
LOG=$(mktemp -d)
# ON_ERROR_STOP=1: um erro aborta o script com exit != 0 (sem falso sucesso).
P() { psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
md5_exp() { P -tA -c "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_exportar'"; }
fail() { echo "FALHA: $1" >&2; exit 1; }

# C1: trava ocupada por outra sessao -> reversao RECUSADA (lock_timeout 5 s), dados e objetos preservados.
ANTES=$(md5_exp)
P -c "BEGIN; LOCK TABLE public.acoes_massivas_lotes IN ROW EXCLUSIVE MODE; SELECT pg_sleep(15); COMMIT;" >"$LOG/holder1" 2>&1 & HOLDER=$!
sleep 2
if P -f "$RB_CONF" >"$LOG/c1" 2>&1; then fail "C1: reversao concluiu com a trava ocupada"; fi
grep -q "55P03\|lock timeout" "$LOG/c1" || fail "C1: a recusa nao foi lock timeout (ver $LOG/c1)"
[ "$(md5_exp)" = "$ANTES" ] || fail "C1: funcao alterada apesar da recusa"
wait $HOLDER || fail "C1: sessao segurando a trava falhou"
echo "C1 ok: lock timeout recusou a reversao e nada mudou"

# C2: trava livre -> reversao CONCLUI (a funcao volta ao corpo publicado de 13/11).
P -f "$RB_CONF" >"$LOG/c2" 2>&1 || fail "C2: reversao deveria concluir com a trava livre (ver $LOG/c2)"
[ "$(md5_exp)" != "$ANTES" ] || fail "C2: reversao 'concluiu' mas a funcao nao mudou"
echo "C2 ok: reversao concluiu com a trava livre"

# C3: exportacao (INSERT = ROW EXCLUSIVE) segura a trava durante a reversao -> reversao RECUSADA.
P -c "BEGIN; INSERT INTO public.acoes_massivas_lotes (canal,arquivo,aluno_ids,total,exportado_por_email,tipo_cobranca,recencia_dias) SELECT 'WHATSAPP','c3.xlsx','{}'::text[],0,'teste@x',NULL,10; SELECT pg_sleep(15); COMMIT;" >"$LOG/holder3" 2>&1 & EXP=$!
sleep 2
if P -f "$RB_PROT" >"$LOG/c3" 2>&1; then fail "C3: reversao concluiu enquanto a exportacao segurava a trava"; fi
wait $EXP || fail "C3: sessao da exportacao falhou"
echo "C3 ok: reversao recusada enquanto a exportacao estava em andamento"
echo "CENARIOS C1-C3 OK (executados contra o banco de teste informado)."

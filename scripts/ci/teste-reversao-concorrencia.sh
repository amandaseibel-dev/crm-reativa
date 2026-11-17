#!/usr/bin/env bash
# Teste de CONCORRENCIA da reversao (20261113100000 / 20261113100100) com DUAS conexoes psql
# independentes. Requer PostgreSQL de teste (nunca producao):
#   PG_URL=postgres://postgres:postgres@localhost:5432/teste_reversao ./scripts/ci/teste-reversao-concorrencia.sh
# Pre-condicao: banco de teste com as migrations 20261113100100 e 20261113100000 JA APLICADAS
# (ordem imposta pelo banco) e pelo menos um aluno com e-mail valido.
# NAO EXECUTADO no ambiente de desenvolvimento local (sem PostgreSQL). Status: pendente.
set -euo pipefail
: "${PG_URL:?defina PG_URL apontando para um banco de TESTE}"
D=supabase/aguardando_aprovacao
RB_CONF="$D/20261113100000_acoes_massivas_confirmar_envio.rollback.sql"
RB_PROT="$D/20261113100100_acoes_massivas_email_so_apos_tabulacao.rollback.sql"
q() { psql "$PG_URL" -qtAX -c "$1"; }
md5_exp() { q "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_exportar'"; }
fail() { echo "FALHA: $1" >&2; exit 1; }

# ---- Cenario 1: trava concorrente causa timeout; nada muda (preservacao) ----
ANTES=$(md5_exp)
psql "$PG_URL" -qX -c "BEGIN; LOCK TABLE public.acoes_massivas_lotes IN ROW EXCLUSIVE MODE; SELECT pg_sleep(15); COMMIT;" &
HOLDER=$!
sleep 2
set +e; psql "$PG_URL" -qX -f "$RB_CONF" >/tmp/c1.log 2>&1; RC=$?; set -e
[ "$RC" -ne 0 ] || fail "C1: reversao NAO devia concluir com a trava ocupada"
grep -qi "lock timeout\|could not obtain lock\|55P03" /tmp/c1.log || fail "C1: erro nao e lock timeout (ver /tmp/c1.log)"
[ "$(md5_exp)" = "$ANTES" ] || fail "C1: funcao alterada apesar do timeout"
wait $HOLDER

# ---- Cenario 2: trava disponivel -> reversao conclui ----
psql "$PG_URL" -qX -f "$RB_CONF" >/dev/null || fail "C2: reversao deveria concluir com a trava livre"
[ "$(md5_exp)" != "$ANTES" ] || fail "C2: reversao concluida, mas a funcao nao mudou"
echo "C2 ok (reaplicar a confirmacao antes de testar C3 se o banco precisar)"

# ---- Cenario 3: exportacao iniciada ANTES da reversao, tentando concluir DEPOIS ----
# Sessao exportadora abre transacao e segura ROW EXCLUSIVE em lotes (como o INSERT da exportacao).
psql "$PG_URL" -qX -c "BEGIN; INSERT INTO public.acoes_massivas_lotes (canal,arquivo,aluno_ids,total,exportado_por_email,tipo_cobranca,recencia_dias) SELECT 'WHATSAPP','c3.xlsx','{}'::text[],0,'teste@x',NULL,10; SELECT pg_sleep(12); ROLLBACK;" &
EXP=$!
sleep 2
set +e; psql "$PG_URL" -qX -f "$RB_PROT" >/tmp/c3.log 2>&1; RC=$?; set -e
[ "$RC" -ne 0 ] || fail "C3: reversao NAO devia concluir enquanto a exportacao segura a trava"
wait $EXP
echo "C3 ok: reversao recusada pela trava/guarda enquanto a exportacao estava em andamento"
echo "TODOS OS CENARIOS PASSARAM (quando executados em banco de teste)."

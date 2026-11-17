#!/usr/bin/env bash
# Teste de CONCORRENCIA das reversoes (20261113100000 / 20261113100100), com conexoes psql
# independentes. Executavel SOMENTE em banco de TESTE: o nome do banco precisa conter "teste"
# (fail-closed). Nao roda contra producao.
#   PG_URL=postgres://.../teste_reversao scripts/ci/teste-reversao-concorrencia.sh
# NAO EXECUTADO no ambiente local (sem PostgreSQL). Status: pendente.
# Pre-condicao: banco de teste recem-criado com as duas migrations aplicadas (100100 antes de 100000).
set -euo pipefail
: "${PG_URL:?defina PG_URL apontando para um banco de TESTE}"
DB=$(psql "$PG_URL" -X -tA -v ON_ERROR_STOP=1 -c "select current_database()")
case "$DB" in *teste*) ;; *) echo "RECUSADO: banco '$DB' nao e de teste (o nome deve conter 'teste')." >&2; exit 2 ;; esac
D=supabase/aguardando_aprovacao
RB_CONF="$D/20261113100000_acoes_massivas_confirmar_envio.rollback.sql"
RB_PROT="$D/20261113100100_acoes_massivas_email_so_apos_tabulacao.rollback.sql"
LOG=$(mktemp -d)
P() { psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
md5_exp() { P -tA -c "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_exportar'"; }
fail() { echo "FALHA: $1" >&2; exit 1; }
# Espera ate a sessao segurar a trava (pg_locks), em vez de sleep fixo.
espera_trava() { for i in $(seq 1 50); do
  n=$(P -tA -c "select count(*) from pg_locks l join pg_class c on c.oid=l.relation where c.relname='acoes_massivas_lotes' and l.mode='RowExclusiveLock' and l.granted")
  [ "$n" -ge 1 ] && return 0; sleep 0.2; done; fail "a sessao nao obteve a trava a tempo"; }

# C1: trava ocupada (ROW EXCLUSIVE por outra sessao) -> reversao RECUSADA por lock timeout; nada muda.
ANTES=$(md5_exp)
P -c "BEGIN; LOCK TABLE public.acoes_massivas_lotes IN ROW EXCLUSIVE MODE; SELECT pg_sleep(15); COMMIT;" >"$LOG/h1" 2>&1 & H1=$!
espera_trava
if P -f "$RB_CONF" >"$LOG/c1" 2>&1; then fail "C1: reversao concluiu com a trava ocupada"; fi
grep -q "55P03\|lock timeout" "$LOG/c1" || fail "C1: a recusa nao foi lock timeout (ver $LOG/c1)"
[ "$(md5_exp)" = "$ANTES" ] || fail "C1: funcao alterada apesar da recusa"
wait $H1 || fail "C1: sessao da trava falhou"
echo "C1 ok: lock timeout recusou a reversao; nada mudou"

# C2: trava livre -> reversao CONCLUI (a funcao muda para o corpo publicado).
P -f "$RB_CONF" >"$LOG/c2" 2>&1 || fail "C2: deveria concluir com a trava livre (ver $LOG/c2)"
[ "$(md5_exp)" != "$ANTES" ] || fail "C2: concluiu mas a funcao nao mudou"
echo "C2 ok: reversao concluiu com a trava livre"

# C3: exportacao (INSERT = ROW EXCLUSIVE) aberta e NAO commitada durante a reversao -> reversao RECUSADA.
# A transacao da exportacao termina com ROLLBACK (nao deixa lote no banco de teste).
P -c "BEGIN; INSERT INTO public.acoes_massivas_lotes (canal,arquivo,aluno_ids,total,exportado_por_email,tipo_cobranca,recencia_dias) SELECT 'WHATSAPP','c3.xlsx','{}'::text[],0,'teste@x',NULL,10; SELECT pg_sleep(15); ROLLBACK;" >"$LOG/h3" 2>&1 & H3=$!
espera_trava
if P -f "$RB_PROT" >"$LOG/c3" 2>&1; then fail "C3: reversao concluiu enquanto a exportacao segurava a trava"; fi
grep -q "55P03\|lock timeout" "$LOG/c3" || fail "C3: a recusa nao foi lock timeout (ver $LOG/c3)"
wait $H3 || fail "C3: sessao da exportacao falhou"
echo "C3 ok: reversao recusada enquanto a exportacao estava em andamento"
echo "C1-C3 OK (executado contra o banco de teste $DB)."

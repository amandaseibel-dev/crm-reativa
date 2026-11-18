#!/usr/bin/env bash
# ============================================================================
# REMANEJAMENTO COM FIDELIZACAO -- prova em PostgreSQL 17 descartavel (CI).
#
# Uso: run.sh <DIR_936>
#   DIR_936: diretorio com o conteudo extraido do commit da PR #936 FIXADO
#            (9e8405869d3fe20ce24f6c50be890076a231a0c1), pelo workflow.
#
# Cenarios, cada um num banco novo:
#   1. SEM #936: a migration RECUSA, e nao deixa nenhuma alteracao parcial.
#   2. COM #936: #936 aplica; depois a migration aplica; depois os testes:
#      destinos, perfis, prazo, saldo/capacidade, concorrencia (2 sessoes), e
#      rollback (marcas alheias preservadas).
#
# Limites: cada psql tem timeout (T, em s). Nada toca producao.
# ============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$DIR/../../.." && pwd)"
D936="${1:?uso: run.sh <DIR_936>}"
T="${T:-300}"
LOGS="${LOGS:-${RUNNER_TEMP:-/tmp}/remanejamento-logs}"
mkdir -p "$LOGS"

MIG936="$D936/supabase/aguardando_aprovacao/20261112210000_fidelizacao_giro_segue_os_10_dias.sql.pendente"
MIG936_MD5="8bcc8d70cf30acf27e89a3236523be7e"
OURS="$RAIZ/supabase/aguardando_aprovacao/20261117150000_remanejamento_fidelizacao_10_dias.sql.pendente"
ROLL="$RAIZ/supabase/aguardando_aprovacao/20261117150000_remanejamento_fidelizacao_10_dias.rollback.sql"
FIX="$RAIZ/supabase/tests/fixtures/remanejamento_fidelizacao_prod_20261117.sql"
ACL="$DIR/fixture_acl.sql"
TD="$DIR"

# \i lib.sql dentro dos testes e relativo ao diretorio atual: entra la antes de rodar.
cd "$TD"

export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"

falha() { echo "FALHA: $*" >&2; exit 1; }
passo() { echo; echo "== $*"; }

# psql com timeout, erro fatal e log proprio
psqlt() { # psqlt <log> <db> <arquivo> [args...]
  # Em falha, imprime o fim do log no proprio job (o artefato pode nao existir).
  local log="$1" db="$2" arq="$3"; shift 3
  if ! timeout "$T" psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$arq" "$@" >"$log" 2>&1; then
    echo "--- falha em $(basename "$arq") (banco $db). Fim do log:" >&2
    tail -n 60 "$log" >&2 || true
    return 1
  fi
}
banco_novo() { # banco_novo <db>
  psql -X -q -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists $1" -c "create database $1" >/dev/null
}
md5_mover() { psql -X -A -t -d "$1" -c "select md5(prosrc) from pg_proc where proname='carteira_geral_mover'"; }

# ----------------------------------------------------------------- CENARIO 1
passo "1. SEM #936: a migration deve recusar sem alteracao parcial"
banco_novo rem_sem936
psqlt "$LOGS/s1_base.log" rem_sem936 "$FIX" || falha "base (fixture) nao carrega: ver $LOGS/s1_base.log"
psqlt "$LOGS/s1_acl.log" rem_sem936 "$ACL" || falha "ACL de producao nao aplicou"
psqlt "$LOGS/s1_seed.log" rem_sem936 "$TD/seed.sql" || falha "seed"
antes="$(md5_mover rem_sem936)"
if timeout "$T" psql -X -q -v ON_ERROR_STOP=1 -d rem_sem936 -f "$OURS" >"$LOGS/s1_migration.log" 2>&1; then
  falha "a migration APLICOU sem a #936 (deveria recusar)"
fi
grep -q "requer a PR #936" "$LOGS/s1_migration.log" || falha "recusa sem a mensagem do gate: ver $LOGS/s1_migration.log"
depois="$(md5_mover rem_sem936)"
[ "$antes" = "$depois" ] || falha "corpo de carteira_geral_mover mudou apesar da recusa"
parcial="$(psql -X -A -t -d rem_sem936 -c "select (select count(*) from information_schema.columns where table_name='casos' and column_name='remanejamento_lote_id') || ',' || (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='internal' and p.proname like 'cg\\_%') || ',' || (select count(*) from pg_trigger where tgname='trg_cg_marcador_segue_a_marca')")"
[ "$parcial" = "0,0,0" ] || falha "alteracao PARCIAL apos recusa: colunas,funcoes,gatilhos = $parcial"
echo "  ok: recusou com o gate, sem alteracao parcial (colunas,funcoes,gatilhos = 0,0,0)"

# ----------------------------------------------------------------- CENARIO 2
passo "2. COM #936 (commit fixado): verificar o arquivo da #936 e aplicar"
[ -f "$MIG936" ] || falha "migration da #936 nao encontrada em $MIG936"
echo "$MIG936_MD5  $MIG936" | md5sum -c - >/dev/null || falha "migration da #936 nao confere com o md5 fixado (commit errado?)"
echo "  ok: md5 da migration da #936 confere"
banco_novo rem_com936
psqlt "$LOGS/s2_base.log" rem_com936 "$FIX" || falha "base (fixture) nao carrega"
psqlt "$LOGS/s2_acl.log" rem_com936 "$ACL" || falha "ACL nao aplicou"
psqlt "$LOGS/s2_seed.log" rem_com936 "$TD/seed.sql" || falha "seed"
if ! psqlt "$LOGS/s2_936.log" rem_com936 "$MIG936"; then
  echo "  #936 NAO aplica sobre a bancada de producao de 17/11: ver $LOGS/s2_936.log"
  exit 2
fi
echo "  ok: #936 aplicada"
psqlt "$LOGS/s2_migration.log" rem_com936 "$OURS" || falha "migration nao aplicou com a #936: ver $LOGS/s2_migration.log"
echo "  ok: migration aplicada sobre a #936"

passo "3. Testes sequenciais (um banco, mesma sessao de cada arquivo)"
for t in p_destinos p_perfis p_prazo p_saldo_capacidade; do
  psqlt "$LOGS/$t.log" rem_com936 "$TD/$t.sql" || falha "$t: ver $LOGS/$t.log"
  echo "  ok: $t"
done

passo "4. Concorrencia: duas sessoes psql em paralelo"
psqlt "$LOGS/conc_setup.log" rem_com936 "$TD/p_conc_setup.sql" || falha "preparo da concorrencia: ver $LOGS/conc_setup.log"
( psqlt "$LOGS/conc_a.log" rem_com936 "$TD/p_conc_a.sql"; echo $? > "$LOGS/conc_a.rc" ) &
pa=$!
( psqlt "$LOGS/conc_b.log" rem_com936 "$TD/p_conc_b.sql"; echo $? > "$LOGS/conc_b.rc" ) &
pb=$!
wait $pa $pb || true
[ "$(cat "$LOGS/conc_a.rc")" = 0 ] || falha "sessao A: ver $LOGS/conc_a.log"
[ "$(cat "$LOGS/conc_b.rc")" = 0 ] || falha "sessao B: ver $LOGS/conc_b.log"
psqlt "$LOGS/conc_cap_a.log" rem_com936 "$TD/p_conc_cap_a.sql" &
ca=$!
psqlt "$LOGS/conc_cap_b.log" rem_com936 "$TD/p_conc_cap_b.sql" &
cb=$!
wait $ca $cb || true
psqlt "$LOGS/conc_check.log" rem_com936 "$TD/p_conc_check.sql" || falha "veredito da concorrencia: ver $LOGS/conc_check.log"
echo "  ok: concorrencia (mesmo caso e teto)"

# ----------------------------------------------------------------- ROLLBACK
passo "5. Rollback: marcas alheias preservadas, so as nossas saem"
banco_novo rem_rollback
psqlt "$LOGS/rb_base.log" rem_rollback "$FIX" || falha "base"
psqlt "$LOGS/rb_acl.log" rem_rollback "$ACL" || falha "acl"
psqlt "$LOGS/rb_seed.log" rem_rollback "$TD/seed.sql" || falha "seed"
psqlt "$LOGS/rb_936.log" rem_rollback "$MIG936" || falha "#936 (rollback)"
psqlt "$LOGS/rb_mig.log" rem_rollback "$OURS" || falha "migration (rollback)"
psqlt "$LOGS/rb_a.log" rem_rollback "$TD/p_rollback_a.sql" || falha "rollback parte A: ver $LOGS/rb_a.log"
psqlt "$LOGS/rb_roll.log" rem_rollback "$ROLL" || falha "rollback nao aplicou (recusou ou erro): ver $LOGS/rb_roll.log"
psqlt "$LOGS/rb_b.log" rem_rollback "$TD/p_rollback_b.sql" || falha "rollback parte B: ver $LOGS/rb_b.log"
echo "  ok: rollback"

echo
echo "TODAS AS VERIFICACOES PASSARAM"

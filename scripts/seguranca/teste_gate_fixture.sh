#!/usr/bin/env bash
# Somente Postgres descartavel local: baseline valido, negativo exato, baseline
# restaurado. Nenhuma excecao na auditoria e nenhuma falha generica aceita.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${DATABASE_URL:?informe a URL do banco descartavel}"
if [[ "${SECURITY_GATE_TESTE_DESCARTAVEL:-}" != sim ]]; then
  echo 'ERRO: exige SECURITY_GATE_TESTE_DESCARTAVEL=sim' >&2
  exit 2
fi
case "$DATABASE_URL" in
  postgres://*@localhost:*/teste|postgresql://*@localhost:*/teste|postgres://*@127.0.0.1:*/teste|postgresql://*@127.0.0.1:*/teste) ;;
  *) echo 'ERRO: somente localhost/127.0.0.1 e banco teste' >&2; exit 2 ;;
esac

# Nao silenciar erro de conexao nem erro SQL.
[[ "$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc 'select current_database()')" == teste ]]
bash "$ROOT/scripts/seguranca/run_security_gate.sh"
echo 'BASELINE VALIDO: gate aprovado sem excecao'

# Esta tabela, diferente da auxiliar do baseline, e DELIBERADAMENTE insegura.
# CREATE sem IF NOT EXISTS: colisao e erro, nunca apagar um objeto preexistente.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
begin;
create table public._teste_gate_sem_rls_negativo (id integer);
revoke all on public._teste_gate_sem_rls_negativo from public, anon, authenticated, service_role;
grant select on public._teste_gate_sem_rls_negativo to authenticated;
commit;
SQL
cleanup() {
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'drop table public._teste_gate_sem_rls_negativo;'
}
trap cleanup EXIT

set +e
saida="$(bash "$ROOT/scripts/seguranca/run_security_gate.sh" 2>&1)"
rc=$?
set -e
printf '%s\n' "$saida"
esperado=$'BLOQUEIA\tTABELA_SEM_RLS\t_teste_gate_sem_rls_negativo\tTabela em public com RLS desligada'
achados="$(awk -F '\t' '$1 == "BLOQUEIA" { print }' <<<"$saida")"
if [[ "$rc" != 1 || "$achados" != "$esperado" ]] \
   || grep -qE 'ERROR:|auditoria SQL NÃO rodou' <<<"$saida" \
   || ! grep -q '^SECURITY GATE: .*REPROVADO$' <<<"$saida"; then
  echo 'FALHA: exige exit 1 e somente o achado BLOQUEIA exato do negativo' >&2
  exit 1
fi
echo 'NEGATIVO EXATO: TABELA_SEM_RLS, objeto esperado e exit 1'
cleanup
trap - EXIT
bash "$ROOT/scripts/seguranca/run_security_gate.sh"
echo 'BASELINE RESTAURADO: gate aprovado sem excecao'

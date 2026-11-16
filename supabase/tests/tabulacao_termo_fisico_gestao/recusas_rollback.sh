#!/usr/bin/env bash
# Recusas do rollback de 20261114120000, em banco com a migração aplicada e sem histórico de termo.
# Cada cenário altera um fator, exige recusa P0001 com o motivo específico, restaura e segue.
# Uso: ROLLBACK=<arquivo.rollback.sql> bash recusas_rollback.sh   (PG* do ambiente)
set -euo pipefail
: "${ROLLBACK:?defina ROLLBACK}"

sql() { psql -v ON_ERROR_STOP=1 -q -c "$1" >/dev/null; }

recusa() {  # $1 = trecho exigido no motivo; $2 = nome do cenário
  local out code
  set +e
  out=$(psql -v ON_ERROR_STOP=1 -f "$ROLLBACK" 2>&1)
  code=$?
  set -e
  if [ "$code" -eq 0 ] || ! echo "$out" | grep -qF "ERROR:  P0001: rollback recusado" || ! echo "$out" | grep -qF "$1"; then
    echo "FALHOU recusa ($2): esperado motivo contendo: $1"
    echo "$out"
    exit 1
  fi
  echo "OK recusa ($2): $1"
}

# 1. aluno com código de termo no estado
sql "update public.alunos set status_atual = 'TERMO_FISICO_ARQUIVADO' where id = 'a0000000-0000-0000-0000-000000000042'"
recusa "aluno(s) com código de termo físico" "aluno"
sql "update public.alunos set status_atual = 'CONTATAR' where id = 'a0000000-0000-0000-0000-000000000042'"

# 2. catálogo alterado depois da migração
sql "update public.tabulacoes set rotulo = 'X' where codigo = 'TERMO_FISICO_ARQUIVADO'"
recusa "catálogo de termo físico foi alterado" "catálogo"
sql "update public.tabulacoes set rotulo = 'Termo físico arquivado, quitado' where codigo = 'TERMO_FISICO_ARQUIVADO'"

# 3. contenção ativa
sql "update public.termo_fisico_contencao set contencao_ativa = true"
recusa "contenção de termo físico está ativa" "contenção ativa"
sql "update public.termo_fisico_contencao set contencao_ativa = false"

# 4. contenção alterada por outro autor
sql "update public.termo_fisico_contencao set alterado_por = 'gestao_manual'"
recusa "contenção foi alterada por outro autor" "contenção alterada"
sql "update public.termo_fisico_contencao set alterado_por = 'migration_termo_fisico'"

echo "OK recusas do rollback: 4 cenários, cada um recusado com motivo específico e restaurado"

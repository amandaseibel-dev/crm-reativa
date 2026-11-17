#!/usr/bin/env bash
# Bloco de contenção do teste 15: liga a contenção, roda 15b e 15c e, em QUALQUER saída (sucesso ou falha),
# restaura o ambiente: 12p_off (flag) e 15p_dono_restore (proprietário dos objetos volta a postgres).
# Código de saída: o da primeira falha do bloco; se não houve falha no bloco e a restauração falhar, o da
# restauração. Falha de restauração é SEMPRE sinalizada em stderr, mesmo quando há falha anterior.
# Uso: PG* do ambiente; DIR = diretório dos testes termo (padrão: diretório deste script).
set -uo pipefail
DIR="${DIR:-$(cd "$(dirname "$0")" && pwd)}"

restaura() {
  local r=0
  psql -v ON_ERROR_STOP=1 -f "$DIR/12p_off.sql" || r=$?
  psql -v ON_ERROR_STOP=1 -f "$DIR/15p_dono_restore.sql" || r=$?
  return "$r"
}

finish() {
  local st=$?
  local rr=0
  trap - EXIT
  restaura || rr=$?
  if [ "$rr" -ne 0 ]; then
    echo "ERRO: restauração do ambiente falhou (código $rr); flag e proprietário podem estar fora do estado original" >&2
  fi
  if [ "$st" -ne 0 ]; then
    exit "$st"
  fi
  exit "$rr"
}
trap finish EXIT

psql -v ON_ERROR_STOP=1 -f "$DIR/12p_on.sql" || exit $?
# 15b e 15c rodam ambos: falha de 15b não suprime 15c (cobertura); o código é o da primeira falha.
rc=0
PGUSER=app_teste PGPASSWORD=app_teste_pw psql -v ON_ERROR_STOP=1 -f "$DIR/15b_dono_contido.sql" || rc=$?
c=0
PGUSER=app_teste_rls PGPASSWORD=app_teste_rls_pw psql -v ON_ERROR_STOP=1 -f "$DIR/15c_update_dono.sql" || c=$?
[ "$rc" -eq 0 ] && rc=$c
[ "$rc" -eq 0 ] && echo "OK contenção 15b/15c"
exit "$rc"

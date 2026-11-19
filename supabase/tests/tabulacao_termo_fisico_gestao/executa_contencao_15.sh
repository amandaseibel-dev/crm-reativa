#!/usr/bin/env bash
# Bloco de contenção do teste 15: liga a contenção, roda 15b e 15c e, em QUALQUER saída (sucesso ou falha),
# restaura o ambiente: flag e autoria da contenção (volta à migração) e 15p_dono_restore (dono volta a postgres).
# Código de saída: o da primeira falha do bloco; se não houve falha no bloco e a restauração falhar, o da
# restauração. Falha de restauração é SEMPRE sinalizada em stderr, mesmo quando há falha anterior.
# Ganchos de falha controlada (SOMENTE para teste em banco descartável; desligados por padrão):
#   FALHA_15B=1, FALHA_15C=1, FALHA_RESTAURA=1 injetam erro real no psql naquele ponto.
# Uso: PG* do ambiente; DIR = diretório dos testes termo (padrão: diretório deste script).
set -uo pipefail
DIR="${DIR:-$(cd "$(dirname "$0")" && pwd)}"

injeta() {  # $1 = nome; executa erro real no servidor, com psql
  psql -v ON_ERROR_STOP=1 -q -c "do \$\$ begin raise exception 'FALHA_INJETADA_$1'; end \$\$;" >/dev/null
}

restaura() {
  local r=0
  if [ "${FALHA_RESTAURA:-0}" = "1" ]; then injeta RESTAURA || r=$?; fi
  # Restaura a flag E a autoria que a migração gravou (o rollback depende de alterado_por).
  psql -v ON_ERROR_STOP=1 -q -c "update public.termo_fisico_contencao set contencao_ativa = false, alterado_em = clock_timestamp(), alterado_por = 'migration_termo_fisico' where id;" >/dev/null || r=$?
  psql -v ON_ERROR_STOP=1 -f "$DIR/15p_dono_restore.sql" || r=$?
  return "$r"
}

finish() {
  local st=$?
  local rr=0
  trap - EXIT
  restaura || rr=$?
  if [ "$rr" -ne 0 ]; then
    echo "ERRO: restauração do ambiente falhou (código $rr); flag, autoria e proprietário podem estar fora do estado original" >&2
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
if [ "${FALHA_15B:-0}" = "1" ]; then injeta 15B || rc=$?; else
  PGUSER=app_teste PGPASSWORD=app_teste_pw psql -v ON_ERROR_STOP=1 -f "$DIR/15b_dono_contido.sql" || rc=$?
fi
echo "[15b rc=$rc]"
c=0
if [ "${FALHA_15C:-0}" = "1" ]; then injeta 15C || c=$?; else
  PGUSER=app_teste_rls PGPASSWORD=app_teste_rls_pw psql -v ON_ERROR_STOP=1 -f "$DIR/15c_update_dono.sql" || c=$?
fi
echo "[15c rc=$c]"
[ "$rc" -eq 0 ] && rc=$c
[ "$rc" -eq 0 ] && echo "OK contenção 15b/15c"
exit "$rc"

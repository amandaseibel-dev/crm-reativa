#!/usr/bin/env bash
# Ordem inválida: a guarda de 20261114130000 deve RECUSAR antes da função de produção estar substituída,
# e a definição não pode mudar. Falha se a guarda aceitar, ou se o hash da função mudar.
set -euo pipefail
: "${DIR:?}" ; : "${BARREIRA:?}"
antes=$(psql -tA -v ON_ERROR_STOP=0 -c "select md5(prosrc) from pg_proc where proname='_encerramento_so_gestao' and pronamespace='public'::regnamespace")
set +e
out=$(psql -v ON_ERROR_STOP=1 -f "$BARREIRA" 2>&1); code=$?
set -e
depois=$(psql -tA -c "select md5(prosrc) from pg_proc where proname='_encerramento_so_gestao' and pronamespace='public'::regnamespace")
[ "$code" -ne 0 ] || { echo "FALHOU: guarda aceitou ordem inválida"; exit 1; }
echo "$out" | grep -qF "pré-condição" || { echo "FALHOU: recusa sem mensagem da guarda"; echo "$out"; exit 1; }
[ "$antes" = "$depois" ] || { echo "FALHOU: definição mudou apesar da recusa"; exit 1; }
echo "OK ordem inválida: recusada, definição inalterada ($antes)"

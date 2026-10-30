#!/usr/bin/env bash
# Testes da M1 de apply_migration: aprovação por registro lido de origin/main.
# Uso: teste-guardiao-apply-migration.sh <caminho do guardiao.sh> <caminho do SQL aprovado>
#
# Cria um repositório temporário com uma origin/main simulada. Não conecta a
# Supabase nem a produção: só alimenta o hook com payloads JSON e confere o
# código de saída (0 = liberado, 2 = bloqueado).
set -uo pipefail

HOOK_ARG="${1:?informe o caminho do guardiao.sh}"
SQL_ARG="${2:?informe o caminho do SQL aprovado}"
HOOK="$(cd "$(dirname "$HOOK_ARG")" && pwd)/$(basename "$HOOK_ARG")"
SQL="$(cd "$(dirname "$SQL_ARG")" && pwd)/$(basename "$SQL_ARG")"

PROJ="ahattpqrjmhkzsmnbdzs"
NOME="acoes_massivas_universo_consolidado_v2"
SHA="4dfc2c9aa7d46e2223227e5238f0f8ff2fa8579a5040a320d74ebce600455cd6"
TOOL="mcp__3e1f85b1-8c91-4d44-b207-0f452630cdc0__apply_migration"
FUTURO="2099-01-01T00:00:00Z"
PASSADO="2000-01-01T00:00:00Z"

if [ "$(shasum -a 256 "$SQL" | cut -c1-64)" != "$SHA" ]; then
  echo "ABORTA: o SQL informado não tem o SHA-256 aprovado"
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP" || exit 1
git init -q .
git config user.email "teste@example.test"
git config user.name "teste"

linha() { # $1 projeto, $2 nome, $3 sha, $4 expira_em, $5 status
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "executor-teste" "$4" "$5"
}

montar_origin() { # $1 = linhas extras do registro (pode ser vazio)
  rm -rf docs
  mkdir -p docs/seguranca
  printf 'projeto\tnome\tsha256\texecutor\texpira_em\tstatus\n' > docs/seguranca/migracoes-aprovadas.tsv
  if [ -n "$1" ]; then printf '%s\n' "$1" >> docs/seguranca/migracoes-aprovadas.tsv; fi
  git add -A
  git commit -q --allow-empty -m "registro simulado"
  git update-ref refs/remotes/origin/main HEAD
}

payload() { # $1 ferramenta, $2 projeto, $3 nome, $4 modo do SQL (exato|alterado|vazio)
  case "$4" in
    exato)
      jq -n --arg t "$1" --arg p "$2" --arg n "$3" --rawfile q "$SQL" \
        '{tool_name:$t, cwd:"/tmp", tool_input:{project_id:$p, name:$n, query:$q}}' ;;
    alterado)
      jq -n --arg t "$1" --arg p "$2" --arg n "$3" --rawfile q "$SQL" \
        '{tool_name:$t, cwd:"/tmp", tool_input:{project_id:$p, name:$n, query:($q + " ")}}' ;;
    vazio)
      jq -n --arg t "$1" --arg p "$2" --arg n "$3" \
        '{tool_name:$t, cwd:"/tmp", tool_input:{project_id:$p, name:$n, query:""}}' ;;
  esac
}

TOTAL=0
FALHAS=0
rodar() { # $1 descrição, $2 código esperado, $3 payload
  local rc
  TOTAL=$((TOTAL + 1))
  printf '%s' "$3" | bash "$HOOK" >/dev/null 2>&1
  rc=$?
  if [ "$rc" = "$2" ]; then
    echo "PASS [$rc] $1"
  else
    echo "FAIL [esperado $2, obteve $rc] $1"
    FALHAS=$((FALHAS + 1))
  fi
}

VALIDA="$(linha "$PROJ" "$NOME" "$SHA" "$FUTURO" pendente)"

montar_origin "$VALIDA"
rodar "aprovação pendente, válida e com SQL exato deve liberar" 0 "$(payload "$TOOL" "$PROJ" "$NOME" exato)"

montar_origin "$(linha "$PROJ" "$NOME" "$SHA" "$FUTURO" aplicada)"
rodar "migration já marcada como aplicada deve bloquear" 2 "$(payload "$TOOL" "$PROJ" "$NOME" exato)"

montar_origin "$(linha "$PROJ" "$NOME" "$SHA" "$PASSADO" pendente)"
rodar "aprovação expirada deve bloquear" 2 "$(payload "$TOOL" "$PROJ" "$NOME" exato)"

montar_origin "$(linha "$PROJ" "$NOME" "$SHA" "$FUTURO" cancelada)"
rodar "aprovação cancelada deve bloquear" 2 "$(payload "$TOOL" "$PROJ" "$NOME" exato)"

montar_origin ""
rodar "registro sem nenhuma aprovação deve bloquear" 2 "$(payload "$TOOL" "$PROJ" "$NOME" exato)"

montar_origin "$VALIDA"
rodar "SQL com um espaço a mais deve bloquear (hash diferente do registro)" 2 "$(payload "$TOOL" "$PROJ" "$NOME" alterado)"
rodar "query vazia deve bloquear" 2 "$(payload "$TOOL" "$PROJ" "$NOME" vazio)"
rodar "projeto diferente do registrado deve bloquear" 2 "$(payload "$TOOL" "outro_projeto" "$NOME" exato)"
rodar "nome diferente do registrado deve bloquear" 2 "$(payload "$TOOL" "$PROJ" "outro_nome" exato)"

git update-ref -d refs/remotes/origin/main
rodar "origin/main ilegível deve bloquear (fail-closed)" 2 "$(payload "$TOOL" "$PROJ" "$NOME" exato)"

montar_origin "$VALIDA"
rodar "create_project continua bloqueado (M1 preservado)" 2 \
  "$(payload "mcp__3e1f85b1-8c91-4d44-b207-0f452630cdc0__create_project" "$PROJ" "$NOME" exato)"
rodar "deploy_edge_function continua bloqueado (M1 preservado)" 2 \
  "$(payload "mcp__3e1f85b1-8c91-4d44-b207-0f452630cdc0__deploy_edge_function" "$PROJ" "$NOME" exato)"
rodar "execute_sql com INSERT sem rollback continua bloqueado (M3 preservado)" 2 \
  '{"tool_name":"mcp__3e1f85b1-8c91-4d44-b207-0f452630cdc0__execute_sql","cwd":"/tmp","tool_input":{"query":"insert into x values (1)"}}'

echo
echo "RESULTADO: $((TOTAL - FALHAS))/$TOTAL verificações aprovadas"
if [ "$FALHAS" -gt 0 ]; then
  echo "FALHOU: $FALHAS verificação(ões)"
  exit 1
fi
echo "APROVADO: código de saída 0"
exit 0

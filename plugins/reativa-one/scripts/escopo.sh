#!/usr/bin/env bash
# ============================================================================
# Escopo da frente de trabalho — o que o Guardião vai deixar editar.
#
#   escopo.sh                      mostra o escopo atual
#   escopo.sh <glob> [<glob> ...]  declara o escopo
#   escopo.sh --limpar             remove a declaração
#
# Grava em .claude/reativa-one.local.md (NÃO versionado). O arquivo guarda
# DECISÃO, nunca credencial: qualquer linha com cara de segredo é recusada.
# ============================================================================
set -uo pipefail

raiz="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$raiz" || exit 1
estado=".claude/reativa-one.local.md"

mostrar() {
  if [ ! -f "$estado" ]; then
    echo "escopo: NÃO DECLARADO (o Guardião não limita caminho de arquivo nesta frente)"
    return 0
  fi
  echo "escopo declarado em $estado:"
  sed -n 's/^escopo: *//p' "$estado" | tr -d '[]"' | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$' | sed 's/^/  · /'
}

case "${1:-}" in
  "") mostrar; exit 0 ;;
  --limpar)
    [ -f "$estado" ] && rm -f "$estado"
    echo "escopo removido."
    exit 0 ;;
esac

for g in "$@"; do
  case "$g" in
    *eyJ*|*sb_secret_*|*sb_publishable_*|*postgres://*|*service_role*|*password*)
      echo "RECUSADO: '$g' tem cara de credencial. Este arquivo guarda decisão, não segredo." >&2
      exit 2 ;;
  esac
done

lista=""
for g in "$@"; do
  [ -n "$lista" ] && lista="$lista, "
  lista="$lista\"$g\""
done

mkdir -p .claude
{
  echo "---"
  echo "escopo: [$lista]"
  echo "declarado_em: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "---"
  echo
  echo "# Escopo desta frente"
  echo
  echo "O Guardião recusa Edit/Write fora dos padrões acima. Para trabalhar em"
  echo "outro módulo, redeclare o escopo ou abra outra frente — não amplie por"
  echo "conveniência no meio de uma correção."
} > "$estado"

mostrar

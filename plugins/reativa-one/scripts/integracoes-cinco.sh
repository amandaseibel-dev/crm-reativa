#!/usr/bin/env bash
# ============================================================================
# "Nunca só um dos cinco" — docs/integracoes/README.md
#
# Descoberta nova de Prime/ULBRA tem de atualizar, NA MESMA ALTERAÇÃO:
#   prime-api.md · prime-api-catalog.json · prime-mapa-fontes-verdade.md
#   · prime-mapa-identificadores.md (quando aplicável) · prime-gaps.md (idem)
#
# Este script não bloqueia nada: ele conta quais dos cinco o diff tocou e diz
# o que falta. Uso: integracoes-cinco.sh [<base>]   (base padrão: origin/main)
# ============================================================================
set -uo pipefail

base="${1:-origin/main}"
raiz="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$raiz" || exit 1

if ! git rev-parse --verify --quiet "$base" >/dev/null; then
  echo "base '$base' não existe neste checkout — informe outra." >&2
  exit 2
fi

mudou="$(git diff --name-only "$base"...HEAD -- docs/integracoes/ 2>/dev/null)"
if [ -z "$mudou" ]; then
  echo "docs/integracoes/: nada alterado neste ramo — nada a conferir."
  exit 0
fi

echo "docs/integracoes/ alterado neste ramo:"
printf '%s\n' "$mudou" | sed 's/^/  · /'
echo

faltam=""
for alvo in prime-api.md prime-api-catalog.json prime-mapa-fontes-verdade.md; do
  if ! printf '%s' "$mudou" | grep -q "$alvo"; then
    faltam="$faltam $alvo"
  fi
done

if [ -n "$faltam" ]; then
  echo "FALTAM (os três obrigatórios andam juntos):"
  for f in $faltam; do echo "  · docs/integracoes/$f"; done
  echo
  echo "prime-mapa-identificadores.md e prime-gaps.md entram quando aplicável."
  exit 1
fi

echo "Os três obrigatórios foram atualizados juntos."
echo "Confira à mão se prime-mapa-identificadores.md e prime-gaps.md se aplicam."

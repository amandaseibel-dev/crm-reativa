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

# Exceção EXCLUSIVA da PR #948 (feat/historico-ficha-piloto): uso explícito por flag,
# só quando o diff de docs/integracoes/ toca APENAS os arquivos abaixo. Não desativa a
# verificação: qualquer outro arquivo, ou qualquer dos três Prime alterados, segue a regra.
# Justificativa: a #948 altera a Mensageria ULBRA e o inventário de Edge Functions; não
# altera contratos da API Prime nem os três documentos Prime.
excecao_948=0
if [ "${1:-}" = "--excecao-948" ]; then excecao_948=1; shift; fi
excecao_948_permitidos="mensageria-ulbra.md prime-edge-functions.md pacote-historico-ficha-publicacao-geral.md"

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

if [ "$excecao_948" = 1 ]; then
  fora=""
  for arq in $(printf "%s" "$mudou" | sed "s#^docs/integracoes/##"); do
    case " $excecao_948_permitidos " in *" $arq "*) ;; *) fora="$fora $arq";; esac
  done
  if [ -n "$fora" ]; then
    echo "Exceção 948 NÃO cobre estes arquivos:$fora" >&2
    echo "A regra dos cinco segue valendo para eles." >&2
    exit 1
  fi
  echo "EXCEÇÃO 948 aplicada (uso explícito): diff só em $excecao_948_permitidos."
  echo "Sem alteração nos três documentos Prime; sem mudança de contrato da API Prime."
  exit 0
fi

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

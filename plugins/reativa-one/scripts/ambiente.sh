#!/usr/bin/env bash
# ============================================================================
# Qual ambiente é este — LIDO, nunca inferido.
#
# A armadilha que este script existe para evitar: supabase/config.toml traz
# project_id = "edlzlfbstshojxrudwaa", que é o identificador LOCAL e parece o
# ref do staging. O projeto remoto de verdade está em
# supabase/.temp/linked-project.json — e é a PRODUÇÃO.
# Ver supabase/ledger/LEIA-ME.md, seção "O projeto remoto deste checkout".
# ============================================================================
set -uo pipefail

PROD_REF="ahattpqrjmhkzsmnbdzs"
STAGING_REF="edlzlfbstshojxrudwaa"

raiz="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$raiz" || exit 1

echo "AMBIENTE — CRM ReATIVA"
echo "----------------------------------------------------------------"
printf 'PROD    (referência documentada) : %s\n' "$PROD_REF"
printf 'STAGING (referência documentada) : %s\n' "$STAGING_REF"
echo

linked="supabase/.temp/linked-project.json"
if [ -f "$linked" ]; then
  ref="$(sed -n 's/.*"ref" *: *"\([^"]*\)".*/\1/p' "$linked" | head -1)"
  printf 'PROJETO LIGADO a este checkout   : %s' "${ref:-"(não foi possível ler)"}"
  case "$ref" in
    "$PROD_REF")    printf '   <<< É A PRODUÇÃO\n' ;;
    "$STAGING_REF") printf '   (staging)\n' ;;
    *)              printf '   (desconhecido — não presuma)\n' ;;
  esac
  printf 'fonte                            : %s\n' "$linked"
else
  echo "PROJETO LIGADO                   : .temp/linked-project.json ausente — NÃO PRESUMA. Rode 'supabase link' ou pergunte."
fi

echo
cfg="$(sed -n 's/^project_id *= *"\([^"]*\)".*/\1/p' supabase/config.toml 2>/dev/null | head -1)"
printf 'config.toml project_id           : %s  (identificador LOCAL — NÃO é o destino remoto)\n' "${cfg:-"(ausente)"}"

echo
echo "GIT"
printf '  branch : %s\n' "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
printf '  base   : %s\n' "$(git log --oneline -1 2>/dev/null)"
sujos="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
printf '  árvore : %s arquivo(s) alterado(s)/não rastreado(s)\n' "$sujos"

echo
echo "FREIOS"
if [ -f .claude/settings.json ]; then
  d="$(grep -c '"' .claude/settings.json 2>/dev/null || echo '?')"
  printf '  Camada 0 (.claude/settings.json)        : presente\n'
  printf '  ↳ regras deny/ask declaradas            : %s linhas com regra\n' "$d"
else
  printf '  Camada 0 (.claude/settings.json)        : AUSENTE — produção está sem freio versionado\n'
fi
if [ -f plugins/reativa-one/hooks/guardiao.sh ]; then
  printf '  Camada 1 (hook do Guardião, arquivo)    : presente\n'
else
  printf '  Camada 1 (hook do Guardião, arquivo)    : AUSENTE\n'
fi
echo "  (arquivo presente não prova hook ATIVO: só /plugin e um teste real provam)"

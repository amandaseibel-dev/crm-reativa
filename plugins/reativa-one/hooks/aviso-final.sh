#!/usr/bin/env bash
# ============================================================================
# Aviso de fim de sessão (hook Stop) — ReATIVA One
#
# Só avisa. Nunca bloqueia: exit 0 sempre, para que um defeito aqui não impeça
# a sessão de encerrar.
#
# Duas perguntas, as duas baratas:
#   1. a camada de permissões (.claude/settings.json) mudou nesta sessão?
#      É o único jeito de a proteção afrouxar sem ninguém ver.
#   2. existe migration nova sem commit? Premissa 15: migration aplicada em
#      produção é commitada no mesmo dia.
# ============================================================================
set -uo pipefail

raiz="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$raiz" 2>/dev/null || exit 0

avisos=""

if ! git diff --quiet HEAD -- .claude/settings.json 2>/dev/null; then
  avisos="${avisos}· A camada de permissões (.claude/settings.json) está alterada e não commitada. Confira o diff antes de encerrar: é ela que protege produção mesmo com o plugin desligado."$'\n'
fi

pendentes="$(git status --porcelain -- supabase/migrations 2>/dev/null | grep -c '^??' || true)"
if [ "${pendentes:-0}" -gt 0 ]; then
  avisos="${avisos}· Há ${pendentes} arquivo(s) novo(s) em supabase/migrations/ sem commit. Premissa 15: migration aplicada é commitada no mesmo dia."$'\n'
fi

if [ -n "$avisos" ]; then
  printf 'GUARDIÃO ReATIVA One — antes de fechar:\n%s' "$avisos"
fi

exit 0

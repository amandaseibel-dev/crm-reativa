#!/usr/bin/env bash
# ============================================================================
# MARCO DE SESSÃO — ReATIVA One · hooks PreCompact e SessionEnd
#
# O QUE FAZ: grava uma linha de ESTADO TÉCNICO em
# .claude/reativa-one.marcos.local.md antes de a conversa ser resumida
# (PreCompact) ou limpa/encerrada (SessionEnd), para a próxima sessão saber
# onde o trabalho parou.
#
# O QUE NÃO FAZ, por desenho:
#   · NÃO BLOQUEIA. exit 0 em todos os caminhos, inclusive nos de erro:
#     compactar é o que mantém uma sessão longa viva, e defeito aqui não pode
#     travá-la. Também não imprime nada — marco não custa contexto.
#   · NÃO GUARDA CONTEÚDO. Do payload do hook só saem dois rótulos de
#     vocabulário fechado (evento e gatilho); qualquer outro valor vira
#     "indeterminado". Nunca entram: nome, CPF, telefone, valor, segredo,
#     caminho absoluto da máquina, instrução de compactação, trecho de conversa.
#   · NÃO SUBSTITUI o registro da decisão. Decisão vira ledger/doc/PR no
#     momento em que é tomada — hook que estoura o timeout não roda, então o
#     marco é rede, não fonte. Ver a skill `economia-de-tokens`.
#
# Contrato: stdin = JSON do hook; saída = arquivo NÃO versionado; exit 0.
# ============================================================================
set -uo pipefail

raiz="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$raiz" 2>/dev/null || exit 0

PAYLOAD="$(cat 2>/dev/null)" || PAYLOAD=""

# ----------------------------------------------------------------------------
# 1. evento e gatilho — vocabulário fechado, nada mais atravessa
# ----------------------------------------------------------------------------
evento=""
gatilho=""
if command -v jq >/dev/null 2>&1; then
  evento="$(printf '%s' "$PAYLOAD" | jq -r '.hook_event_name // empty' 2>/dev/null)" || evento=""
  gatilho="$(printf '%s' "$PAYLOAD" | jq -r '.trigger // .reason // empty' 2>/dev/null)" || gatilho=""
fi

# sem jq: reconhece o evento pela presença do literal, sem copiar nada
if [ -z "$evento" ]; then
  case "$PAYLOAD" in
    *'"PreCompact"'*) evento="PreCompact" ;;
    *'"SessionEnd"'*) evento="SessionEnd" ;;
  esac
fi

case "$evento" in
  PreCompact|SessionEnd) ;;
  *) evento="indeterminado" ;;
esac
case "$gatilho" in
  manual|auto|clear|resume|logout|prompt_input_exit) ;;
  *) gatilho="indeterminado" ;;
esac

# ----------------------------------------------------------------------------
# 2. estado: branch, HEAD, escopo declarado, contagem por área
#    (área = diretório de primeiro nível; caminho de arquivo não entra)
# ----------------------------------------------------------------------------
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || branch="?"
head="$(git rev-parse --short HEAD 2>/dev/null)" || head="?"

# o valor vem de arquivo: filtra PRIMEIRO, e só depois aplica rótulo nosso —
# assim nada de fora atravessa, e o rótulo não é mutilado pelo filtro
escopo_bruto="$(sed -n 's/^escopo: *//p' .claude/reativa-one.local.md 2>/dev/null | head -1)" || escopo_bruto=""
escopo="$(printf '%s' "$escopo_bruto" | tr -cd 'A-Za-z0-9_.,:/*"{}[] -' | cut -c1-200)"
case "$escopo_bruto" in
  *eyJ*|*sb_secret_*|*sb_publishable_*|*postgres://*|*service_role*|*password*)
    escopo="(recusado: cara de credencial)" ;;
esac
[ -z "$escopo" ] && escopo="(não declarado)"

total="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')" || total="?"
areas="$(git status --porcelain 2>/dev/null \
  | sed 's/^...//' | tr -d '"' \
  | awk -F/ '{print (NF>1 ? $1 : "(raiz)")}' \
  | sort | uniq -c | sort -rn \
  | awk '{printf "%s=%s ", $2, $1}' | sed 's/ *$//')" || areas=""

# ----------------------------------------------------------------------------
# 3. grava e sai. Falha de escrita também sai 0.
# ----------------------------------------------------------------------------
arquivo=".claude/reativa-one.marcos.local.md"
mkdir -p .claude 2>/dev/null || exit 0

if [ ! -f "$arquivo" ]; then
  {
    echo "# Marcos de sessão — ReATIVA One"
    echo
    echo "Estado técnico gravado antes de resumir (PreCompact) ou limpar/encerrar"
    echo "(SessionEnd) uma sessão. Arquivo NÃO versionado e SEM conteúdo: nenhum"
    echo "dado de aluno, valor, segredo ou trecho de conversa entra aqui — só"
    echo "evento, branch, HEAD, escopo declarado e contagem de arquivos por área."
    echo
    echo "A decisão em si mora no ledger, no doc ou no PR. Este arquivo é rede."
    echo
    echo "| UTC | evento | gatilho | branch | HEAD | escopo | alterados |"
    echo "|---|---|---|---|---|---|---|"
  } >> "$arquivo" 2>/dev/null || exit 0
fi

printf '| %s | %s | %s | %s | %s | %s | %s |\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  "$evento" "$gatilho" "$branch" "$head" "$escopo" \
  "${total:-0} (${areas:-nenhum})" >> "$arquivo" 2>/dev/null

exit 0

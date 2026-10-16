#!/usr/bin/env bash
# ============================================================================
# GUARDIÃO — ReATIVA One · Camada 1 (hook PreToolUse)
#
# O QUE ELE É: um freio determinístico. Não lê conversa, não interpreta
# intenção, não pergunta nada. Recebe a chamada de ferramenta em JSON, decide
# por regra escrita, e devolve 0 (siga) ou 2 (bloqueado).
#
# O QUE ELE NÃO É: a única proteção. As proibições absolutas (db push,
# apply_migration, deploy, merge, main) também moram em .claude/settings.json,
# que é VERSIONADO e independe deste plugin. Motivo: hook que estoura o timeout
# não bloqueia — hook lento vira hook ausente. Ver README, seção "Três camadas".
#
# DESENHO FAIL-CLOSED, em duas partes:
#   1. saída imediata (exit 0) para ferramenta que não está na lista de
#      guardadas. Um defeito aqui não pode travar leitura.
#   2. dentro da região guardada, INDETERMINADO = NEGA. JSON ilegível, campo
#      ausente, jq faltando, payload inesperado: nega e diz por quê.
#
# Caminhos cobertos (ver README §Superfície): Bash · Edit/Write/NotebookEdit ·
# MCP por SUFIXO do nome da ferramenta (sobrevive a troca do id do conector) ·
# terminal do app (a linha de comando é reavaliada pelas MESMAS regras de Bash)
# · navegador (navegação para SQL Editor/REST de produção) · sessão na nuvem.
#
# Contrato: stdin = JSON do PreToolUse; exit 2 + motivo no stderr = bloqueado.
# ============================================================================
set -uo pipefail

VERSAO="1.0.0"

# ----------------------------------------------------------------------------
# saída padrão
# ----------------------------------------------------------------------------
negar() {
  # $1 = regra, $2 = motivo, $3 = o que fazer
  {
    printf 'GUARDIÃO ReATIVA One — BLOQUEADO [%s]\n' "$1"
    printf '%s\n' "$2"
    [ -n "${3:-}" ] && printf 'Caminho autorizado: %s\n' "$3"
  } >&2
  exit 2
}

PAYLOAD="$(cat 2>/dev/null)" || PAYLOAD=""

# ----------------------------------------------------------------------------
# 1. Esta chamada é guardada? Se não for, sai sem custo.
#    (lista positiva: o que não está aqui não é avaliado)
# ----------------------------------------------------------------------------
TOOL=""
if command -v jq >/dev/null 2>&1; then
  TOOL="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)" || TOOL=""
fi
# sem jq ou sem tool_name: pode ser payload de outro formato. Só vira bloqueio
# se a carga MENCIONAR algo guardado — assim um defeito de parsing não trava a
# sessão inteira, mas também não deixa passar o que importa.
if [ -z "$TOOL" ]; then
  case "$PAYLOAD" in
    *supabase*|*apply_migration*|*deploy_edge_function*|*git\ push*|*pr\ merge*|*vercel*)
      negar "payload-indeterminado" \
        "Não foi possível ler o nome da ferramenta nesta chamada, e a carga menciona uma operação crítica. Por desenho, o indeterminado é negado." \
        "rode 'command -v jq' e confira o hook; ou repita a ação por um caminho auditável" ;;
    *) exit 0 ;;
  esac
fi

case "$TOOL" in
  Bash|Edit|Write|NotebookEdit|MultiEdit) ;;
  mcp__*) ;;
  *) exit 0 ;;
esac

# Daqui para baixo: região guardada. Indeterminado = nega.
JQ() { printf '%s' "$PAYLOAD" | jq -r "$1" 2>/dev/null; }
if ! printf '%s' "$PAYLOAD" | jq -e . >/dev/null 2>&1; then
  negar "json-ilegivel" \
    "A carga desta chamada não é JSON válido e a ferramenta ($TOOL) é guardada." \
    "nenhum — reporte o defeito do hook"
fi

CWD="$(JQ '.cwd // empty')"
[ -z "$CWD" ] && CWD="$PWD"

# ----------------------------------------------------------------------------
# normalização: o esqueleto do comando, sem aspas nem barras de escape, para
# que `npx "supabase" db\ push` case igual a `npx supabase db push`.
# Não é embelezamento: é o que impede o contorno por citação.
# ----------------------------------------------------------------------------
esqueleto() {
  printf '%s' "$1" \
    | tr '\n\t' '  ' \
    | tr -d "\"'\\\\" \
    | tr -s ' '
}

# ----------------------------------------------------------------------------
# REGRAS DE LINHA DE COMANDO
# Usadas pelo Bash E pelo terminal do app (mcp__terminal__run_in_terminal),
# para que o mesmo comando não passe só por ter chegado por outra porta.
# ----------------------------------------------------------------------------
avaliar_comando() {
  local cmd="$1" origem="$2"
  local e; e="$(esqueleto "$cmd")"
  local el; el="$(printf '%s' "$e" | tr '[:upper:]' '[:lower:]')"

  # R1 — CLI do Supabase que reescreve ou reverte produção.
  # docs/RUNBOOK-MIGRATIONS.md, regra nº 1: db push é PROIBIDO, sem exceção.
  if printf '%s' "$el" | grep -Eq '(^| |/)supabase[^ ]* '; then
    if printf '%s' "$el" | grep -Eq 'db +push|db +reset|migration +repair|migration +up'; then
      negar "R1/db-push" \
        "[$origem] Este comando usa o CLI do Supabase para reescrever o banco: $(printf '%s' "$e" | cut -c1-120)" \
        "aplicar schema é passo humano (ver docs/RUNBOOK-MIGRATIONS.md). Nenhum agente aplica."
    fi
  fi

  # R2 — Vercel CLI: publicação não passa por agente.
  if printf '%s' "$el" | grep -Eq '(^| )(npx +(--yes +|-y +)?)?vercel( |$)'; then
    negar "R2/deploy" \
      "[$origem] Publicação pela Vercel não é operação de agente: $(printf '%s' "$e" | cut -c1-120)" \
      "deploy é decisão da gestão, feita por você"
  fi

  # R3 — merge de PR, por qualquer forma (inclui a API, que faz merge por PUT).
  if printf '%s' "$el" | grep -Eq 'gh +pr +merge'; then
    negar "R3/merge" "[$origem] Merge de PR exige autorização explícita sua." "abrir o PR e deixar a revisão/merge com você"
  fi
  if printf '%s' "$el" | grep -Eq 'gh +api' \
     && printf '%s' "$el" | grep -Eq '(-x|--method) *(put|post|patch|delete)' \
     && printf '%s' "$el" | grep -Eq '/merge|/merges|/deployments|/protection|/rulesets|/actions|auto_?merge'; then
    negar "R3/merge-api" \
      "[$origem] Chamada de API do GitHub que mescla, publica ou mexe em proteção de branch." \
      "nenhum — essa decisão é sua"
  fi

  # R4 — push perigoso e qualquer escrita com HEAD na branch principal.
  if printf '%s' "$el" | grep -Eq '(^| )git +push'; then
    if printf '%s' "$el" | grep -Eq -- '--force|--force-with-lease| -f( |$)|--delete| :[a-z]'; then
      negar "R4/push-forcado" "[$origem] push forçado ou que apaga ref remota." "push normal da sua branch de trabalho"
    fi
    if printf '%s' "$el" | grep -Eq '(^| )(origin|upstream)? *(main|master)( |$)|:(main|master)( |$)|head:(main|master)'; then
      negar "R4/push-main" "[$origem] push direto para a branch principal." "abrir PR a partir da branch de trabalho"
    fi
  fi
  if printf '%s' "$el" | grep -Eq '(^| )git +(commit|merge|rebase|revert|cherry-pick|am|apply|reset|push)'; then
    local br; br="$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)" || br=""
    case "$br" in
      main|master)
        negar "R4/HEAD-em-main" \
          "[$origem] HEAD está em '$br' e o comando escreve no histórico. A branch principal não é alterada por agente." \
          "criar/entrar numa branch de trabalho antes" ;;
    esac
  fi
  if printf '%s' "$el" | grep -Eq '(^| )git +(reset +--hard|clean +-[a-z]*[fdx]|stash +(pop|drop|clear))'; then
    negar "R4/destrutivo-local" \
      "[$origem] Comando git que descarta trabalho não commitado. 'git stash' é por REPOSITÓRIO, não por worktree — já derrubou 16 arquivos de outra frente." \
      "commit numa branch de trabalho, ou cópia manual do arquivo"
  fi

  # R5 — escrita por shell em caminho protegido (desvia de Edit/Write).
  if printf '%s' "$e" | grep -Eq '>>?|(^| )(tee|cp|mv|install|ln|rsync)( |$)|sed +-i|perl +-0?pi'; then
    if printf '%s' "$e" | grep -Eq 'supabase/ledger/'; then
      negar "R5/ledger" \
        "[$origem] O ledger é registro byte a byte do que rodou em produção: um comentário nosso muda o md5, que é a própria prova." \
        "nenhum — ledger não se edita"
    fi
    if printf '%s' "$e" | grep -Eq '\.claude/settings(\.local)?\.json'; then
      negar "R5/desarme" "[$origem] Alterar as permissões da sessão por shell." "você edita, com revisão em diff"
    fi
    if printf '%s' "$e" | grep -Eq 'supabase/migrations/'; then
      negar "R5/migration" \
        "[$origem] Nesta fase nenhum agente escreve migration (o agente de Banco é da Fase 2)." \
        "propor o SQL no chat para você aplicar"
    fi
    if printf '%s' "$e" | grep -Eq '(^| )\.git/|/\.git/'; then
      negar "R5/git-interno" "[$origem] Escrita direta dentro de .git/." "comandos git normais"
    fi
  fi

  # R6 — segredo no transcript.
  if printf '%s' "$el" | grep -Eq '(^| )printenv( |$)|(^| )env *(\||$)|(^| )set *\|'; then
    negar "R6/segredo-ambiente" "[$origem] Despejar o ambiente expõe credencial no histórico da conversa." "pedir a variável específica, por nome, a você"
  fi
  # Os arquivos de EXEMPLO não têm valor e são rastreados no git: tira-os da
  # inspeção antes de procurar por .env, senão `cat .env.example` é barrado à
  # toa — e regra que incomoda sem motivo é regra que alguém desliga.
  local sem_exemplo
  sem_exemplo="$(printf '%s' "$e" | sed -E 's/\.env\.(example|sample|template|dist)//g')"
  if printf '%s' "$sem_exemplo" | grep -Eq '\.env(\.|$| )' \
     && printf '%s' "$el" | grep -Eq '(^| )(cat|less|more|head|tail|awk|sed|grep|sort|strings|xxd|od|base64|cp|scp|curl|tee)( |$)'; then
    negar "R6/segredo-arquivo" "[$origem] Leitura/cópia de arquivo .env — tem credencial de produção." "usar .env.example, que não tem valor"
  fi

  # R7 — escrita no próprio Guardião por shell.
  if printf '%s' "$e" | grep -Eq 'plugins/reativa-one/hooks/' \
     && printf '%s' "$e" | grep -Eq '>>?|(^| )(tee|cp|mv|rm)( |$)|sed +-i|perl +-0?pi'; then
    negar "R7/auto-desarme" "[$origem] O Guardião não se desarma por linha de comando." "editar com revisão em diff, aprovado por você"
  fi

  # R8 — rede que ESCREVE em produção (GET segue sob aprovação da Camada 0).
  if printf '%s' "$el" | grep -Eq '(^| )(curl|wget)( |$)' \
     && printf '%s' "$el" | grep -Eq 'ahattpqrjmhkzsmnbdzs' \
     && printf '%s' "$el" | grep -Eq -- '-x *(post|put|patch|delete)|--request *(post|put|patch|delete)|--data|-d '; then
    negar "R8/rede-escreve-prod" \
      "[$origem] Requisição que escreve no projeto de PRODUÇÃO (ahattpqrjmhkzsmnbdzs)." \
      "leitura (GET) segue permitida sob aprovação; escrita é sua"
  fi

  # R9 — psql apontado para produção.
  if printf '%s' "$el" | grep -Eq '(^| )psql( |$)' && printf '%s' "$el" | grep -Eq 'ahattpqrjmhkzsmnbdzs'; then
    negar "R9/psql-prod" "[$origem] Conexão direta de linha de comando ao banco de PRODUÇÃO." "auditoria de leitura pelo script de segurança, com DATABASE_URL vindo do ambiente"
  fi

  return 0
}

# ----------------------------------------------------------------------------
# REGRAS DE CAMINHO DE ARQUIVO (Edit/Write/NotebookEdit)
# ----------------------------------------------------------------------------
avaliar_caminho() {
  local p="$1" origem="$2"
  local rel="${p#"$CWD"/}"

  case "$rel" in
    supabase/ledger/*)
      negar "P1/ledger" "[$origem] $rel — o ledger é prova byte a byte; editar quebra o md5." "nenhum" ;;
    .claude/settings.local.json)
      negar "P2/permissoes" "[$origem] Este arquivo não é versionado: mudança nele é invisível na revisão." "você edita à mão" ;;
    supabase/migrations/*)
      negar "P3/migration" "[$origem] Nesta fase nenhum agente escreve migration." "propor o SQL no chat" ;;
    .git/*)
      negar "P4/git-interno" "[$origem] Escrita dentro de .git/." "comandos git normais" ;;
  esac

  # P5 — nome de migration que a catraca do CI reprovaria (antecipa o erro).
  case "$rel" in
    supabase/migrations/*__*.sql)
      negar "P5/nome-ledger" "[$origem] Arquivo com '__' dentro de migrations/ é padrão de LEDGER; a catraca reprova." "nome <14 dígitos>_<descricao>.sql" ;;
  esac

  # P6 — escopo declarado em .claude/reativa-one.local.md. Quando não há
  # declaração, não bloqueia (não inventa limite que você não pediu).
  local estado="$CWD/.claude/reativa-one.local.md"
  if [ -f "$estado" ]; then
    local escopos
    escopos="$(sed -n 's/^escopo: *//p' "$estado" 2>/dev/null | tr -d '[]"' | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$')" || escopos=""
    if [ -n "$escopos" ]; then
      local dentro=0 g
      while IFS= read -r g; do
        [ -z "$g" ] && continue
        # shellcheck disable=SC2254
        case "$rel" in $g) dentro=1; break ;; esac
      done <<< "$escopos"
      if [ "$dentro" -eq 0 ]; then
        negar "P6/fora-do-escopo" \
          "[$origem] $rel está fora do escopo declarado desta frente:"$'\n'"$(printf '%s' "$escopos" | sed 's/^/  · /')" \
          "/reativa:escopo para redeclarar, ou abrir outra frente para esse módulo"
      fi
    fi
  fi

  return 0
}

# ----------------------------------------------------------------------------
# 2. Despacho por ferramenta
# ----------------------------------------------------------------------------
case "$TOOL" in

  Bash)
    CMD="$(JQ '.tool_input.command // empty')"
    [ -z "$CMD" ] && negar "bash-sem-comando" "Chamada de Bash sem comando legível no payload." "nenhum"
    avaliar_comando "$CMD" "Bash"
    ;;

  Edit|Write|NotebookEdit|MultiEdit)
    P="$(JQ '.tool_input.file_path // .tool_input.notebook_path // empty')"
    [ -z "$P" ] && negar "arquivo-sem-caminho" "Chamada de $TOOL sem caminho legível no payload." "nenhum"
    avaliar_caminho "$P" "$TOOL"
    ;;

  # ---- MCP: casado por SUFIXO, não pelo id do conector. Se o conector for
  # recriado com outro id, a regra continua valendo.
  mcp__*)
    SUF="${TOOL##*__}"

    case "$SUF" in
      apply_migration|deploy_edge_function|pause_project|restore_project|create_project|\
create_branch|delete_branch|merge_branch|reset_branch|rebase_branch|confirm_cost)
        negar "M1/banco-producao" \
          "$TOOL escreve ou reconfigura o projeto Supabase. O projeto ligado a este checkout é a PRODUÇÃO (ahattpqrjmhkzsmnbdzs)." \
          "migration é passo humano; ver docs/RUNBOOK-MIGRATIONS.md" ;;

      create_deployment|request_promote|request_rollback|assign_alias|cancel_deployment|\
start_rolling_release|approve_rolling_release_stage|complete_rolling_release|\
create_project_env|edit_project_env|update_project_protection_bypass|patch_url_protection_bypass|\
put_firewall_config|update_firewall_config)
        negar "M2/deploy" "$TOOL publica, promove ou reconfigura o ambiente servido." "deploy é decisão sua" ;;

      execute_sql)
        Q="$(JQ '.tool_input.query // empty' | tr '[:upper:]' '[:lower:]')"
        [ -z "$Q" ] && negar "M3/sql-sem-query" "execute_sql sem query legível." "nenhum"
        # Filtro de verbo é defesa EM CIMA da aprovação da Camada 0, nunca em
        # lugar dela: execute_sql está em "ask" no settings.json.
        if printf '%s' "$Q" | grep -Eq '(^|[^a-z_])(insert|update|delete|truncate|drop|alter|create|grant|revoke|comment|reindex|vacuum|refresh)([^a-z_]|$)'; then
          if ! printf '%s' "$Q" | grep -Eq '(^|[^a-z_])rollback([^a-z_]|$)'; then
            negar "M3/sql-escreve" \
              "A consulta contém verbo de escrita e não termina em rollback." \
              "leitura; ou 'begin; … rollback;' para teste de perfil (docs/seguranca §9)"
          fi
        fi ;;

      run_in_terminal|open_terminal_tab)
        C="$(JQ '.tool_input.command // .tool_input.text // empty')"
        [ -n "$C" ] && avaliar_comando "$C" "terminal-do-app"
        ;;

      navigate)
        U="$(JQ '.tool_input.url // empty' | tr '[:upper:]' '[:lower:]')"
        if printf '%s' "$U" | grep -Eq 'supabase\.com/dashboard/.*/(sql|editor)|supabase\.com/project/.*/sql'; then
          negar "M4/sql-editor" "Navegação para o SQL Editor do Supabase. Escrita em produção pela tela é decisão sua, na sua sessão." "você abre o SQL Editor"
        fi
        if printf '%s' "$U" | grep -Eq 'ahattpqrjmhkzsmnbdzs\.supabase\.co/(rest|functions|storage)'; then
          negar "M4/rest-prod" "Navegação direta para a API de produção pelo navegador." "leitura pelas telas do CRM"
        fi ;;

      javascript_tool)
        T="$(JQ '.tool_input.text // empty' | tr '[:upper:]' '[:lower:]')"
        if printf '%s' "$T" | grep -Eq 'supabase\.co/(rest|functions|storage)|service_role|/rpc/'; then
          negar "M5/js-chama-prod" "Script de página chamando a API do Supabase." "ler a tela; escrita é sua"
        fi ;;

      start_session)
        TGT="$(JQ '.tool_input.target // empty')"
        if [ "$TGT" = "cloud" ]; then
          negar "M6/sessao-nuvem" \
            "Sessão na nuvem roda fora desta máquina: nenhum hook deste plugin vale lá." \
            "sessão local, onde o Guardião está de pé"
        fi ;;
    esac
    ;;
esac

exit 0

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

# ----------------------------------------------------------------------------
# FASE 2 — BANCO. Libera APENAS Edit/Write/NotebookEdit de migration, e apenas
# no worktree e na branch que a gestão nomeou em REATIVA_FASE2_BANCO no
# LANÇAMENTO desta sessão. Consultada em UM lugar só: P3/migration.
#
# ESCRITA POR SHELL NÃO É LIBERADA EM NENHUMA HIPÓTESE. R5/migration segue
# integral, porque o comando não revela o destino da escrita e o CWD vem do
# payload. Esta função não é chamada de lá.
#
# POR QUE VARIÁVEL DE AMBIENTE, e não arquivo: o agente não escreve o ambiente
# deste processo -- o hook é processo irmão, criado pelo harness, e estado de
# shell não atravessa chamadas de ferramenta. Posta em arquivo lido pelo
# lançador (.claude/settings.json), a autorização voltaria a ser forjável; por
# isso aquele arquivo passou a ser protegido em P2.
#
# NÃO libera aplicação: M1, R9, a regra do CLI, R4, R7 e o deny versionado não
# consultam esta função.
#
# FAIL-CLOSED: variável ausente, malformada, git ilegível, caminho
# indeterminado, destino fora da pasta de migrations = NEGA.
fase2_liberada() {
  local alvo="${1:-}" aut="${REATIVA_FASE2_BANCO:-}"
  [ -n "$alvo" ] && [ -n "$aut" ] || return 1
  case "$aut" in *'|'*) ;; *) return 1 ;; esac
  # EXATAMENTE dois campos. `${aut##*|}` pegaria o ÚLTIMO campo e engoliria em
  # silêncio o do meio de "raiz|lixo|branch", então a checagem é no RESTO.
  local raiz_aut="${aut%%|*}" br_aut="${aut#*|}"
  case "$br_aut" in *'|'*) return 1 ;; esac
  [ -n "$raiz_aut" ] && [ -n "$br_aut" ] || return 1

  # CAMINHO REAL DO ARQUIVO. Resolve link simbólico no diretório que o contém;
  # o arquivo pode ainda não existir (é uma criação), o diretório tem de existir.
  local dir
  dir="$(cd "$(dirname "$alvo")" 2>/dev/null && pwd -P)" || return 1

  git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  local raiz br gd gcd
  raiz="$(cd "$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null && pwd -P)" || return 1
  br="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)" || return 1
  [ -n "$raiz" ] && [ -n "$br" ] || return 1

  # SÓ EM WORKTREE VINCULADO, nunca no checkout principal. Num worktree o
  # git-dir é .git/worktrees/<nome> e difere do git-common-dir; no principal
  # os dois coincidem. Sem caminho fixo no código.
  # `--path-format=absolute` É OBRIGATÓRIO: no checkout principal o git devolve
  # `--git-common-dir` RELATIVO (`../../.git`), e resolvê-lo com `cd` o
  # interpretaria contra o diretório do PROCESSO DO HOOK, não contra $dir --
  # fazendo gd != gcd passar espúrio e liberar o checkout de produção.
  gd="$(git -C "$dir" rev-parse --path-format=absolute --git-dir 2>/dev/null)" || return 1
  gcd="$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  [ -n "$gd" ] && [ -n "$gcd" ] || return 1
  # `cd ""` devolve 0 em bash: os -n acima são o que impede o passe silencioso.
  gd="$(cd "$gd" 2>/dev/null && pwd -P)" || return 1
  gcd="$(cd "$gcd" 2>/dev/null && pwd -P)" || return 1
  [ -n "$gd" ] && [ -n "$gcd" ] && [ "$gd" != "$gcd" ] || return 1

  # DESTINO DENTRO DA PASTA DE MIGRATIONS do próprio worktree, pelo caminho
  # real: barra `..`, link que escapa e homônimo em outro lugar da árvore.
  local pasta
  pasta="$(cd "$raiz/supabase/migrations" 2>/dev/null && pwd -P)" || return 1
  [ "$dir" = "$pasta" ] || return 1

  # resolve link simbólico também no lado da autorização, antes de comparar
  local raiz_aut_r
  raiz_aut_r="$(cd "$raiz_aut" 2>/dev/null && pwd -P)" || return 1

  [ "$br" != "main" ] && [ "$br" != "master" ] || return 1

  [ "$raiz" = "$raiz_aut_r" ] && [ "$br" = "$br_aut" ]
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
  #
  # `-i` AQUI, no portão EXTERNO, e não só nos ramos: `TEE`, `CP`, `MV`, `RM` e
  # `SED` executam neste volume (medido). Sem o `-i` nesta linha o `if` não
  # entrava, e o `-i` dos quatro ramos nunca era consultado -- `CP a.sql
  # supabase/migrations/x.sql` e `CP a .claude/settings.json` passavam. Achado da
  # sétima auditoria, a segunda sobre caixa: normalizar o ramo não serve se o
  # portão que leva até ele não estiver normalizado.
  if printf '%s' "$e" | grep -Eiq '>>?|(^| )(tee|cp|mv|install|ln|rsync)( |$)|sed +-i|perl +-0?pi'; then
    # SEM exigir a barra final: `ln -s .../supabase/migrations <atalho>` nomeia a
    # PASTA, não um arquivo dentro dela, e passava -- criando um atalho pelo qual
    # a escrita chegava por caminho canônico. Vale igual para o ledger.
    # FRONTEIRA = COMPLEMENTO DO NOME, e `-i`. A classe `($|[/ "'])` da tentativa
    # anterior não cobria `;` nem `>`, então `cd supabase/ledger;echo a>b.sql`
    # passava -- regressão que eu troquei pelo colateral da pasta homônima.
    # O complemento cobre qualquer separador; o `_` fora dele é o que preserva
    # `migrations_historicas_nao_comprovadas`. `-i` porque o volume é
    # case-insensitive e `supabase/LEDGER/` grava na pasta real.
    if printf '%s' "$e" | grep -Eiq 'supabase/ledger($|[^_A-Za-z0-9])'; then
      negar "R5/ledger" \
        "[$origem] O ledger é registro byte a byte do que rodou em produção: um comentário nosso muda o md5, que é a própria prova." \
        "nenhum — ledger não se edita"
    fi
    # `-i`: `.Claude/settings.json` e `.claude/Settings.json` são o MESMO arquivo
    # neste volume, e escapavam.
    if printf '%s' "$e" | grep -Eiq '\.claude/settings(\.local)?\.json'; then
      negar "R5/desarme" "[$origem] Alterar as permissões da sessão por shell." "você edita, com revisão em diff"
    fi
    # FRONTEIRA = COMPLEMENTO DO NOME, não barra final nem lista de separadores.
    # Sem a barra o padrão pegava `supabase/migrations_historicas_nao_comprovadas/`,
    # que NÃO é protegida e existe no repositório; com a lista `($|[/ "'])`,
    # `cd supabase/migrations; cat > x.sql` escapava. O complemento resolve os
    # dois: `_` fora da classe preserva a pasta homônima, e `;`, `>`, `|`, `&`
    # entram. `-i` porque o volume é case-insensitive e `supabase/MIGRATIONS/`
    # grava na pasta real.
    if printf '%s' "$e" | grep -Eiq 'supabase/migrations($|[^_A-Za-z0-9])'; then
      negar "R5/migration" \
        "[$origem] Nesta fase nenhum agente escreve migration (o agente de Banco é da Fase 2)." \
        "propor o SQL no chat para você aplicar"
    fi
    # `-i`: `.GIT/config` é o mesmo arquivo neste volume (medido) e escapava.
    if printf '%s' "$e" | grep -Eiq '(^| )\.git/|/\.git/'; then
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
  # Sobre a cópia MINÚSCULA (`$el`), não sobre `$e`: `cat .ENV` lê o mesmo
  # arquivo neste volume e escapava. E a isenção tem de ser casada na mesma
  # caixa, senão `.ENV.example` deixa de ser reconhecido como exemplo e passa a
  # ser barrado à toa -- foi o que o caso F77 pegou.
  local sem_exemplo
  sem_exemplo="$(printf '%s' "$el" | sed -E 's/\.env\.(example|sample|template|dist)//g')"
  if printf '%s' "$sem_exemplo" | grep -Eq '\.env(\.|$| )' \
     && printf '%s' "$el" | grep -Eq '(^| )(cat|less|more|head|tail|awk|sed|grep|sort|strings|xxd|od|base64|cp|scp|curl|tee)( |$)'; then
    negar "R6/segredo-arquivo" "[$origem] Leitura/cópia de arquivo .env — tem credencial de produção." "usar .env.example, que não tem valor"
  fi

  # R7 — escrita no próprio Guardião por shell.
  #
  # `-i` É O MAIS IMPORTANTE DOS TRÊS: `plugins/reativa-one/HOOKS/guardiao.sh` é
  # o MESMO arquivo neste volume, inclusive no checkout de onde o plugin ativo é
  # carregado. Sobrescrever o hook derruba todas as regras de uma vez -- R1, R9,
  # M1 incluídas. O desarme por shell, que o runbook declarava barrado, estava
  # aberto por uma letra maiúscula. Achado da sexta auditoria.
  # O SEGUNDO grep TAMBÉM precisa do `-i`: `CP novo.sh <hook>` e `RM <hook>`
  # passavam, com a caixa do caminho já corrigida. Mesmo furo da rodada
  # anterior, por outra letra.
  if printf '%s' "$e" | grep -Eiq 'plugins/reativa-one/hooks/' \
     && printf '%s' "$e" | grep -Eiq '>>?|(^| )(tee|cp|mv|rm)( |$)|sed +-i|perl +-0?pi'; then
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
# NORMALIZA A GRAFIA DO CAMINHO antes de qualquer `case`. Os padrões são
# literais e o `*` do case come barra, então grafias equivalentes do MESMO
# arquivo escapavam de todas as regras de caminho: `.claude//settings.json`,
# `.claude/./settings.json`, `supabase//ledger/...`, `supabase//migrations/...`
# -- esta última sem nem consultar o portão da Fase 2, em qualquer checkout.
# Reproduzido pela auditoria do Guardião em 26/10/2026.
#
# Normalização TEXTUAL de propósito, sem resolver link simbólico: `rel` é
# calculado tirando o prefixo do $CWD, e resolver só um dos dois lados
# transformaria todo caminho em absoluto, desarmando as regras relativas e o
# escopo declarado (P6). Quem resolve o caminho real é fase2_liberada, com
# `cd`/`pwd -P`, e ela já estava correta.
normalizar_caminho() {
  # Padrão e substituição vêm de variáveis SEM ASPAS, e isso é deliberado --
  # duas armadilhas medidas aqui, as duas em bash 3.2 (o /bin/bash do macOS):
  #   1. `${s//\/\//\/}`: o lado da substituição não é desescapado, então o `\/`
  #      inseria uma BARRA INVERTIDA literal;
  #   2. `${s//"$pat"/"$rep"}`: em 3.2 as aspas internas entram no texto,
  #      produzindo `.claude"/"settings.json`.
  # Sem aspas funciona nas duas versões, e `//` e `/./` não têm glob.
  local s="$1" dois="//" ponto="/./" um="/"

  # APARA ESPAÇO E TABULAÇÃO NAS PONTAS. `P2/permissoes` e
  # `P2/permissoes-versionadas` são os dois ÚNICOS padrões de correspondência
  # exata do hook -- todos os outros terminam em `*`, que come o espaço. Medido:
  # `.claude/settings.json ` com espaço no fim, e com espaço no início, escapavam
  # dos dois. Nas regras que sustentam a não-autoconcessão. Achado da oitava
  # auditoria; se a gravação atinge o arquivo real depende de a ferramenta de
  # escrita aparar o argumento, o que NÃO foi comprovado -- e o freio não
  # terceiriza essa premissa.
  while :; do case "$s" in [[:space:]]*) s="${s#?}" ;; *) break ;; esac; done
  while :; do case "$s" in *[[:space:]]) s="${s%?}" ;; *) break ;; esac; done
  while [ "$s" != "${s//$dois/$um}" ]; do s="${s//$dois/$um}"; done
  while [ "$s" != "${s//$ponto/$um}" ]; do s="${s//$ponto/$um}"; done
  s="${s%/.}"   # final "/."
  s="${s#./}"   # inicial "./"

  # COLAPSA `..` POR SEGMENTO, sem tocar o sistema de arquivos. É isto que
  # fecha `-x/../supabase/functions/../migrations/...` e
  # `supabase/zz_inexistente/../migrations/...`: a resolução pelo disco falhava
  # (nome começando com `-`, ou diretório que ainda não existe) e a 2ª passagem
  # era pulada EM SILÊNCIO -- falha aberta, contra a doutrina da linha 134
  # ("indeterminado = nega"). Aqui não há como falhar: é texto.
  #
  # Com link simbólico no meio, colapsar `..` textualmente dá um caminho
  # DIFERENTE do real. Não é problema: as duas formas são avaliadas, e uma forma
  # a mais só pode NEGAR mais, nunca liberar. O custo é um falso positivo
  # possível (`<link>/../supabase/migrations/x.sql`), na direção segura.
  local pre="" out="" seg glob_antes
  case "$s" in /*) pre="/" ;; esac

  # `set -f` É OBRIGATÓRIO: `for seg in $s` sem aspas faz word splitting E
  # EXPANSÃO DE CAMINHO. Sem isto, `supabase/*/../migrations/x.sql` virava
  # `supabase/aa/bb/migrations/x.sql` -- o par protegido DESAPARECIA do texto --
  # e o veredito passava a depender do conteúdo do diretório do processo do hook:
  # com o diretório vazio o glob não casava e o mesmo payload era negado.
  # Reproduzido pela quinta auditoria do Guardião.
  case "$-" in *f*) glob_antes=1 ;; *) glob_antes=0 ;; esac
  set -f
  local IFS='/'
  for seg in $s; do
    case "$seg" in
      ''|.) ;;
      ..)
        if [ -z "$out" ] || [ "$out" = ".." ] || [ "${out##*/}" = ".." ]; then
          out="${out:+$out/}.."
        else
          case "$out" in
            */*) out="${out%/*}" ;;
            *)   out="" ;;
          esac
        fi
        ;;
      *) out="${out:+$out/}$seg" ;;
    esac
  done
  [ "$glob_antes" = 0 ] && set +f
  printf '%s' "$pre$out"
}

# CAMINHO REAL do arquivo: resolve link simbólico e `..` de verdade, pedindo ao
# sistema de arquivos. O arquivo pode não existir ainda (é uma criação), o
# diretório tem de existir. Vazio quando não há como resolver.
caminho_real() {
  local p="$1" dir base n=0 alvo
  # `--` É OBRIGATÓRIO: dirname/basename do macOS tratam um nome que começa com
  # `-` como opção ("illegal option"), devolvem vazio e a 2ª passagem morria em
  # silêncio -- a via `-x/../.../migrations/...`, reproduzida pela auditoria.
  # O colapso textual de `..` já cobre essa via; isto conserta a ferramenta.
  #
  # ÚLTIMO COMPONENTE: se ele mesmo for link, segue o link. Sem isto, `Write`
  # num link que aponta para o arquivo protegido escapava, porque só o
  # diretório era resolvido.
  while [ -L "$p" ] && [ "$n" -lt 10 ]; do
    alvo="$(readlink -- "$p" 2>/dev/null)" || break
    [ -n "$alvo" ] || break
    case "$alvo" in
      /*) p="$alvo" ;;
      *)  p="$(dirname -- "$p" 2>/dev/null)/$alvo" ;;
    esac
    n=$((n + 1))
  done
  dir="$(cd "$(dirname -- "$p" 2>/dev/null)" 2>/dev/null && pwd -P)" || return 0
  [ -n "$dir" ] || return 0
  base="$(basename -- "$p" 2>/dev/null)"
  [ -n "$base" ] || return 0
  printf '%s' "${dir%/}/$base"
}

# As regras de NEGAÇÃO, avaliadas contra UMA forma do caminho. São chamadas duas
# vezes: com a forma textual normalizada e com o caminho real. Basta uma casar.
#
# POR QUE DUAS FORMAS. A normalização textual não resolve `..` nem link
# simbólico, e os padrões são literais:
#   supabase/functions/../migrations/<ts>.sql  -> escapava de P3 sem consultar o
#     portão, em UM passo, em qualquer checkout (a pasta `functions` existe);
#   <atalho>/<ts>.sql, com <atalho> -> .../supabase/migrations, é caminho
#     CANÔNICO e escapava igual.
# Resolver só o caminho real também não serve: `rel` nasce de tirar o prefixo do
# diretório corrente, e quando um dos dois lados tem link simbólico a forma real
# fica absoluta e as regras relativas e o escopo (P6) deixariam de casar. Então
# as duas formas são avaliadas, e P6 segue só na textual.
# Achado da terceira auditoria do Guardião, 26/10/2026.
regras_de_negacao() {
  local rel_original="$1" p="$2" origem="$3" rel

  # CASA SEM DISTINGUIR CAIXA. O volume deste projeto é case-INSENSITIVE
  # (medido: `cd supabase/MIGRATIONS` abre a mesma pasta), então
  # `supabase/MIGRATIONS/<arquivo>.sql` GRAVA DENTRO da pasta real e escapava de
  # todos os padrões, que são literais e minúsculos. Um passo, sem preparo, em
  # qualquer checkout -- inclusive o de produção. A 2ª passagem não salvava:
  # `pwd -P` não canoniza caixa, então a forma real saía idêntica à textual e a
  # comparação que dispara a 2ª passagem dava falso.
  # Defeito PRÉ-EXISTENTE (os padrões sempre foram sensíveis a caixa), achado
  # pela quinta auditoria do Guardião.
  #
  # Num volume case-SENSITIVE uma pasta `supabase/MIGRATIONS` seria outra pasta
  # e passaria a ser barrada sem necessidade. É over-block na direção segura, de
  # uma pasta que não existe no repositório -- preferível ao furo.
  #
  # A mensagem segue mostrando o caminho ORIGINAL: quem lê precisa ver o que
  # pediu, não a cópia minúscula.
  rel="$(printf '%s' "$rel_original" | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz')"

  # TODO PADRÃO TEM O PAR ABSOLUTO. `rel` só fica relativo quando o caminho
  # começa exatamente com "$CWD/": com caminho absoluto de outro checkout, ou do
  # mesmo repositório visto de uma subpasta, `rel` segue absoluto e o padrão
  # relativo sozinho NÃO casa -- a escrita escapava de todas estas regras.
  # Achado do caso F11 e da auditoria do Guardião de 26/10/2026.
  case "$rel" in
    supabase/ledger/*|*/supabase/ledger/*)
      negar "P1/ledger" "[$origem] $rel_original — o ledger é prova byte a byte; editar quebra o md5." "nenhum" ;;
    .claude/settings.local.json|*/.claude/settings.local.json)
      negar "P2/permissoes" "[$origem] Este arquivo não é versionado: mudança nele é invisível na revisão." "você edita à mão" ;;
    .claude/settings.json|*/.claude/settings.json)
      # Carrega o deny/ask e o bloco `env` da sessão: alterá-lo é conceder
      # permissão a si mesmo, inclusive a autorização da Fase 2 de Banco.
      # Antes só R5/desarme o protegia, e apenas no caminho shell.
      negar "P2/permissoes-versionadas" \
        "[$origem] Este arquivo carrega o deny/ask e o ambiente da sessão: alterá-lo é conceder permissão a si mesmo." \
        "você edita, com revisão em diff" ;;
    supabase/migrations/*|*/supabase/migrations/*)
      # O segundo padrão cobre caminho ABSOLUTO fora do $CWD: `rel` continua
      # absoluto e o padrão relativo sozinho não casava, então uma escrita em
      # outro worktree escapava de P3 sem nem consultar o portão (achado do
      # caso F11 do autoteste).
      fase2_liberada "$p" || negar "P3/migration" \
        "[$origem] $rel_original — Fase 2 de Banco não autorizada para este worktree e branch." \
        "propor o SQL no chat, ou a gestão lançar a sessão com REATIVA_FASE2_BANCO" ;;
    .git/*|*/.git/*)
      negar "P4/git-interno" "[$origem] Escrita dentro de .git/." "comandos git normais" ;;
  esac

  # P5 — nome de migration que a catraca do CI reprovaria (antecipa o erro).
  case "$rel" in
    supabase/migrations/*__*.sql|*/supabase/migrations/*__*.sql)
      negar "P5/nome-ledger" "[$origem] Arquivo com '__' dentro de migrations/ é padrão de LEDGER; a catraca reprova." "nome <14 dígitos>_<descricao>.sql" ;;
  esac
}

avaliar_caminho() {
  local p origem cwd
  p="$(normalizar_caminho "$1")"; origem="$2"
  cwd="$(normalizar_caminho "$CWD")"
  local rel="${p#"$cwd"/}"

  # 1ª passagem: forma textual normalizada.
  regras_de_negacao "$rel" "$p" "$origem"

  # 2ª passagem: caminho real. Fecha `..` no meio e link simbólico. Quando a
  # resolução falha (diretório inexistente) não há 2ª passagem -- e aí não há
  # escrita possível tampouco.
  local preal relreal cwdreal
  preal="$(caminho_real "$p")"
  if [ -n "$preal" ] && [ "$preal" != "$p" ]; then
    cwdreal="$(cd "$cwd" 2>/dev/null && pwd -P)" || cwdreal="$cwd"
    relreal="${preal#"${cwdreal%/}"/}"
    regras_de_negacao "$relreal" "$preal" "$origem"
  fi

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

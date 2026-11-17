#!/usr/bin/env bash
# ============================================================================
# "Nunca só um dos cinco" — docs/integracoes/README.md
#
# Descoberta ou mudança de contrato da integração PRIME exige coerência entre os CINCO artefatos:
#   prime-api.md · prime-api-catalog.json · prime-mapa-fontes-verdade.md
#   · prime-mapa-identificadores.md (quando aplicável) · prime-gaps.md (idem)
#
# Alcance (decisão de gestão, registrada em docs/integracoes/decisoes-integracao-ulbra.md):
#   Documentação exclusiva da Mensageria não aciona a regra.
#
# Caminhos Prime (inventário real):
#   docs/integracoes/prime-*             documentos Prime
#   supabase/functions/prime-*/          funções Prime
#   src/utils/prime*                     contrato e utilitários Prime
#   supabase/(migrations|ledger)/*prime* migrações Prime
# Compartilhados com regra Prime (mudança aqui também aciona a revisão):
#   docs/PREMISSAS.md, docs/BACKLOG-TECNICO.md, docs/integracoes/README.md, este script
#
# Resultados e códigos de saída:
#   NAO_APLICA            (0) nenhum caminho Prime nem compartilhado relevante foi alterado.
#   PRESENCA_VERIFICADA   (0) algum dos três obrigatórios foi tocado e os três estão no ramo.
#                             Verifica SÓ presença e toque. Conteúdo e necessidade de atualização
#                             dos cinco NÃO são verificados: a revisão humana de coerência continua.
#   REVISAO_HUMANA        (3) há código, migração ou compartilhado Prime alterado sem os três
#                             obrigatórios, ou só documento Prime auxiliar foi alterado. Exige revisão
#                             humana antes de qualquer aprovação. Não é aprovação automática.
#   FALTAM:<lista>        (2) algum dos três obrigatórios foi tocado e outros dos três faltam no ramo.
#
# Onde REVISAO_HUMANA é resolvido: a revisão do Guardião (plugins/reativa-one/agents/guardiao.md) o
# reporta como pendência e a PR só é aprovada depois que um humano registra a decisão (ver a seção
# de revisão humana em docs/integracoes/README.md).
#
# Não bloqueia o CI sozinho; a exigência é a revisão acima. Uso: integracoes-cinco.sh [<base>]
#   Teste sem git: integracoes-cinco.sh --lista <arquivo>   (formato de git diff --name-status)
# ============================================================================
set -uo pipefail

if [ "${1:-}" = "--lista" ]; then
  alt="$(cat "${2:?informe o arquivo de lista}")"
else
  base="${1:-origin/main}"
  raiz="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  cd "$raiz" || exit 1
  if ! git rev-parse --verify --quiet "$base" >/dev/null; then
    echo "base '$base' não existe neste checkout — informe outra." >&2
    exit 2
  fi
  # -M: renomeação vira "R<n>\tantigo\tnovo". Exclusões (D) aparecem com o caminho removido.
  alt="$(git diff --name-status -M "$base"...HEAD 2>/dev/null)"
fi

# Todos os caminhos tocados (origem e destino de renomeações; exclusões incluídas).
caminhos="$(printf '%s\n' "$alt" | awk -F'\t' 'NF>=2 {for (i=2;i<=NF;i++) print $i}' | sort -u)"
# Caminhos que EXISTEM depois da alteração (destino de renomeação; exclusão e origem ficam de fora).
existentes="$(printf '%s\n' "$alt" | awk -F'\t' 'NF>=2 && $1 !~ /^D/ {print $NF}' | sort -u)"

if [ -z "$caminhos" ]; then echo "NAO_APLICA: nada alterado neste ramo."; exit 0; fi

prime_docs="$(printf '%s\n' "$caminhos" | grep -E '^docs/integracoes/prime-[^/]+$' || true)"
prime_codigo="$(printf '%s\n' "$caminhos" | grep -E '^(supabase/functions/prime-[^/]+/|src/utils/prime|supabase/(migrations|ledger)/.*prime)' || true)"
compartilhado="$(printf '%s\n' "$caminhos" | grep -E '^(docs/PREMISSAS\.md|docs/BACKLOG-TECNICO\.md|docs/integracoes/README\.md|plugins/reativa-one/scripts/integracoes-cinco\.sh)$' || true)"
obrigatorios_tocados="$(printf '%s\n' "$caminhos" | grep -E '^docs/integracoes/prime-(api\.md|api-catalog\.json|mapa-fontes-verdade\.md)$' || true)"

if [ -z "$prime_docs" ] && [ -z "$prime_codigo" ] && [ -z "$compartilhado" ]; then
  echo "NAO_APLICA: nenhum caminho Prime nem compartilhado relevante foi alterado (só Mensageria ou outros)."
  exit 0
fi

# Sem os três obrigatórios tocados: código, migração, compartilhado ou só auxiliar -> revisão humana (3).
if [ -z "$obrigatorios_tocados" ]; then
  echo "REVISAO_HUMANA: alterado Prime sem prime-api.md, prime-api-catalog.json nem prime-mapa-fontes-verdade.md:"
  printf '%s\n' "$prime_docs" "$prime_codigo" "$compartilhado" | grep -v '^$' | sed 's/^/  · /'
  echo "Revisão humana obrigatória: confirme se há descoberta ou mudança de contrato; se houver, atualize os cinco na mesma alteração. Não é aprovação automática."
  exit 3
fi

# Algum dos três foi tocado: presença dos três no ramo.
echo "Obrigatórios tocados:"; printf '%s\n' "$obrigatorios_tocados" | sed 's/^/  · /'
faltam=""
for alvo in prime-api.md prime-api-catalog.json prime-mapa-fontes-verdade.md; do
  printf '%s\n' "$existentes" | grep -qx "docs/integracoes/$alvo" || faltam="$faltam $alvo"
done
if [ -n "$faltam" ]; then echo "FALTAM:$faltam"; exit 2; fi
echo "PRESENCA_VERIFICADA: os três obrigatórios estão no ramo. Presença e toque conferidos; conteúdo e necessidade de atualização dos cinco NÃO verificados. Revisão humana de coerência continua obrigatória."
echo "(prime-mapa-identificadores.md e prime-gaps.md: conferir quando aplicável.)"
exit 0

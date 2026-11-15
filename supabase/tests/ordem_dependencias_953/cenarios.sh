#!/usr/bin/env bash
# ============================================================================
# ORDEM DE DEPENDÊNCIAS da #953: #936 -> teto -> prazo -> #953.
# Uso: cenarios.sh <raiz_da_936_no_SHA_9e840586> <raiz_desta_arvore>
# Banco DESCARTÁVEL (CI). Mesma sequência de fixtures da bancada da #936.
# 1) carrega o artefato da #936 pelo SHA fixado e imprime md5(prosrc) e md5(pg_get_functiondef);
# 2) recusa a ordem errada ANTES de alterar objetos (verifica md5 antes/depois);
# 3) executa a ordem correta.
# ============================================================================
set -euo pipefail
R936="$1"; R953="$2"
p()  { psql -X -q -v ON_ERROR_STOP=1 "$@"; }
v()  { psql -X -A -t -q -c "$1"; }
falhou=0
snap() { v "select coalesce(md5(pg_get_functiondef('public.caso_dentro_prazo_fidelizacao(date)'::regprocedure)),'-') || '|' || coalesce(md5(pg_get_functiondef('public.trg_impor_teto_operador()'::regprocedure)),'-')"; }
ALVO="$R936/supabase/aguardando_aprovacao/20261112210000_fidelizacao_giro_segue_os_10_dias.sql.pendente"
FX="$R936/supabase/tests/fixtures"

echo "== artefato da #936 (9e840586)"
sha256sum "$ALVO"
echo "== bancada da #936: ambiente e fixtures de producao"
p -f "$R936/supabase/tests/concorrencia_fidelizacao_giro/01_ambiente.sql"
for f in "$FX/fidelizacao_por_dono_prod_20260930.sql" "$FX/nivelamento_m3_prod_20261021.sql" \
         "$FX/assumir_caso_livre_prod_20261020.sql" \
         "$R936/supabase/migrations/20261020230350_assumir_caso_livre_teto_oficial_e_tres_carteiras.sql" \
         "$FX/onda1_executor_prod_20261021.sql" "$FX/fidelizacao_giro_prod_20261112.sql" \
         "$FX/fidelizacao_giro_lotes_prod_20261112.sql"; do
  p -f "$f"
done
p -c "create or replace function auth.jwt() returns jsonb language sql stable as \$s\$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb \$s\$;"
echo "== artefato #936 aplicado"
p -f "$ALVO"
echo "== md5 do artefato carregado (dois métodos, nunca misturados)"
v "select 'aluno_retorno_operador_vigente md5(prosrc)=' || md5(prosrc) || ' md5(functiondef)=' || md5(pg_get_functiondef(oid)) from pg_proc where proname='aluno_retorno_operador_vigente'"
v "select 'trg_impor_teto_operador md5(prosrc)=' || md5(prosrc) from pg_proc where proname='trg_impor_teto_operador'"

echo "== recusa da ordem errada: #953 antes do prazo e do teto"
antes=$(snap)
if p -f "$R953/supabase/aguardando_aprovacao/20261113120000_assumir_caso_fidelizacao_vencida.sql.pendente" 2>/tmp/ordem953.err; then
  echo "  FALHA: #953 aplicou fora de ordem"; falhou=1
elif grep -q "ORDEM: prazo" /tmp/ordem953.err; then
  echo "  ok   #953 recusada: $(grep -o 'ORDEM[^\"]*' /tmp/ordem953.err | head -1)"
else
  echo "  FALHA: recusa sem a mensagem de ordem"; cat /tmp/ordem953.err; falhou=1
fi
[ "$antes" = "$(snap)" ] && echo "  ok   nenhum objeto alterado pela recusa" || { echo "  FALHA: objetos alterados pela recusa"; falhou=1; }

echo "== recusa: prazo antes do teto"
antes=$(snap)
if p -f "$R953/supabase/aguardando_aprovacao/20261114100000_alinhar_prazo_fidelizacao_data_brasilia.sql.pendente" 2>/tmp/ordemprazo.err; then
  echo "  FALHA: prazo aplicou sem o teto"; falhou=1
elif grep -q "ORDEM: teto" /tmp/ordemprazo.err; then
  echo "  ok   prazo recusado sem o teto"
else
  echo "  FALHA: recusa do prazo sem a mensagem de ordem"; cat /tmp/ordemprazo.err; falhou=1
fi
[ "$antes" = "$(snap)" ] && echo "  ok   nenhum objeto alterado pela recusa do prazo" || { echo "  FALHA: objetos alterados pela recusa do prazo"; falhou=1; }

echo "== ordem correta: teto -> prazo -> #953"
p -f "$R953/supabase/tests/fixtures/assumir_caso_fidelizacao_vencida_prod_20261113.sql"  # internal.pode_alterar_responsavel (P3)
p -f "$R953/supabase/aguardando_aprovacao/20261114110000_serializar_teto_todos_os_caminhos.sql.pendente"
p -f "$R953/supabase/aguardando_aprovacao/20261114100000_alinhar_prazo_fidelizacao_data_brasilia.sql.pendente"
p -f "$R953/supabase/aguardando_aprovacao/20261113120000_assumir_caso_fidelizacao_vencida.sql.pendente"
echo "== ordem correta concluída"
exit $falhou

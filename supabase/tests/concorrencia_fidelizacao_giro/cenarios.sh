#!/usr/bin/env bash
# ============================================================================
# CONCORRÊNCIA REAL — fidelização do giro (PR #936)
#
# A bancada de PGlite roda em UMA sessão e por isso nunca provou concorrência.
# Aqui são DUAS sessões `psql` de verdade, contra um Postgres descartável.
#
# Prova três cenários nas operações afetadas:
#   1. LIBERAÇÃO: duas liberações simultâneas do MESMO caso não soltam duas
#      vezes nem gravam histórico em dobro (o `for update` serializa).
#   2. LOTE: um operador segurando a linha de um aluno NÃO derruba o lote; o
#      aluno é pulado pelo `lock_timeout` e os demais seguem.
#   3. ASSUNÇÃO: dois operadores assumindo o mesmo caso ao mesmo tempo — só um
#      vence; o outro recebe recusa, e o caso fica com um dono só.
#
# SOMENTE em banco descartável do CI. Nada aqui toca produção.
# ============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$DIR/../../.." && pwd)"
psqlq() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }
valor()  { psql -X -A -t -q -c "$1"; }
falhou=0
checa() { # checa <descricao> <esperado> <obtido>
  if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; else echo "  FALHA $1: esperado '$2', obtido '$3'"; falhou=1; fi
}

echo "== montando a bancada (fixtures de produção + migration pendente)"
FX="$RAIZ/supabase/tests/fixtures"
psqlq -f "$DIR/01_ambiente.sql"
for f in "$FX/fidelizacao_por_dono_prod_20260930.sql" \
         "$FX/nivelamento_m3_prod_20261021.sql" \
         "$FX/assumir_caso_livre_prod_20261020.sql" \
         "$RAIZ/supabase/migrations/20261020230350_assumir_caso_livre_teto_oficial_e_tres_carteiras.sql" \
         "$FX/onda1_executor_prod_20261021.sql" \
         "$FX/fidelizacao_giro_prod_20261112.sql" \
         "$FX/fidelizacao_giro_lotes_prod_20261112.sql"; do
  psqlq -f "$f"
done
# auth.jwt() fiel ao Supabase: sem claims devolve NULL (é assim que o cron passa).
psqlq -c "create or replace function auth.jwt() returns jsonb language sql stable as \$s\$
            select nullif(current_setting('request.jwt.claims', true), '')::jsonb \$s\$;"
psqlq -f "$RAIZ/supabase/aguardando_aprovacao/20261112210000_fidelizacao_giro_segue_os_10_dias.sql.pendente"
psqlq -f "$DIR/02_dados.sql"

A=00000000-0000-0000-0000-000000000001
B=00000000-0000-0000-0000-000000000002
C=00000000-0000-0000-0000-000000000003

echo
echo "== 1. LIBERAÇÃO simultânea do mesmo caso (duas sessões)"
psql -X -q -c "select public.liberar_fidelizacao_caso('$A');" > /tmp/lib1.out 2>&1 &
psql -X -q -c "select public.liberar_fidelizacao_caso('$A');" > /tmp/lib2.out 2>&1 &
wait
checa "o caso ficou sem operador"            "1" "$(valor "select count(*) from public.casos where id='$A' and operador_email is null")"
checa "histórico de liberação gravado 1 vez" "1" "$(valor "select count(*) from public.historico_operadores_alunos where cpf_referencia='70000000001' and acao='FIDELIZACAO_EXPIRADA'")"

echo
echo "== 2. LOTE com um aluno travado por um operador"
psqlq -c "update public.casos set operador_email='op1@teste.local', operador_nome='OP UM' where id='$A';"
psqlq -c "delete from public.historico_operadores_alunos;"
psqlq -f "$RAIZ/supabase/recovery/20261112_giro_fidelizacao_00_backup.sql" > /dev/null
# sessão 1: o operador abre transação e segura a linha do aluno B por 12 s
psql -X -q -c "begin; select 1 from public.casos where id='$B' for update; select pg_sleep(12); rollback;" >/dev/null 2>&1 &
TRAVA=$!
sleep 2
# sessão 2: o lote roda com lock_timeout de 5 s — tem de PULAR o aluno B e concluir
sed "s/v_lote int := 1;/v_lote int := 1;/" "$RAIZ/supabase/recovery/20261112_giro_fidelizacao_01_liberar_lote.sql" > /tmp/lote.sql
if psqlq -f /tmp/lote.sql > /tmp/lote.out 2>&1; then echo "  ok   o lote concluiu sem abortar"; else echo "  FALHA o lote abortou:"; tail -3 /tmp/lote.out; falhou=1; fi
wait $TRAVA 2>/dev/null || true
checa "aluno travado foi PULADO (não liberado)" "1" "$(valor "select count(*) from public._backup_fidelizacao_giro_20261112 where caso_id='$B' and liberado_em is null and pulado_motivo is not null")"
checa "aluno travado continua com o operador"   "1" "$(valor "select count(*) from public.casos where id='$B' and operador_email='op1@teste.local'")"
checa "os outros do lote foram liberados"       "2" "$(valor "select count(*) from public._backup_fidelizacao_giro_20261112 where liberado_em is not null")"

echo
echo "== 3. ASSUNÇÃO simultânea do mesmo caso (dois operadores)"
psqlq -c "drop table if exists public._backup_fidelizacao_giro_20261112;"
psqlq -c "update public.casos set operador_email=null, operador_nome=null, operador=null where id='$C';
          update public.alunos set responsavel_atual_email=null, responsavel_atual_nome=null where id='$C';"
for OP in op1 op2; do
  psql -X -A -t -q -c "select set_config('request.jwt.claims', '{\"email\":\"${OP}@teste.local\"}', false);
                       select sucesso from public.assumir_caso_livre('$C');" > /tmp/ass_$OP.out 2>&1 &
done
wait
VENCEDORES=$(cat /tmp/ass_op1.out /tmp/ass_op2.out | grep -c "^t$" || true)
checa "exatamente um operador assumiu" "1" "$VENCEDORES"
checa "o caso tem um dono só"          "1" "$(valor "select count(*) from public.casos where id='$C' and operador_email is not null")"

echo
if [ "$falhou" -ne 0 ]; then echo "CONCORRÊNCIA: REPROVADO"; exit 1; fi
echo "CONCORRÊNCIA: todos os cenários passaram"

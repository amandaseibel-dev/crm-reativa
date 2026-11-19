#!/usr/bin/env bash
# Prova de recuperação do trap do teste 15 em PostgreSQL REAL descartável (CI). Nunca rode fora de banco descartável.
# Para cada cenário: reconstrói o banco, aplica a prep do teste 15, fotografa o estado (consulta independente),
# roda executa_contencao_15.sh (com ou sem falha injetada), fotografa de novo e exige:
#   - código de saída = o da PRIMEIRA falha (ou 0 no controle);
#   - marcadores de 15b e 15c (15c roda mesmo após falha de 15b);
#   - estado final IGUAL ao inicial (flag, autoria e proprietário);
#   - falha de restauração sinalizada em stderr.
set -uo pipefail
D=supabase/tests/tabulacao_termo_fisico_gestao
MIG=supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente
ALUNO='a0000000-0000-0000-0000-000000000042'
FAIL=0
q() { psql -tA -v ON_ERROR_STOP=1 -c "$1"; }

estado() {  # consulta independente, como postgres, de flag, autoria e proprietários
  q "select 'flag=' || contencao_ativa || '|autor=' || alterado_por from public.termo_fisico_contencao where id"
  q "select 'dono_tabela=' || pg_get_userbyid(relowner) from pg_class where oid = 'public.termo_fisico_contencao'::regclass"
  q "select 'dono_' || proname || '=' || pg_get_userbyid(proowner) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('usuario_e_gestao','app_usuario_ativo','aluno_movimentacao_tabulacao_so_gestao','registrar_administrativo_termo_fisico') order by proname"
}

reconstroi() {
  psql -v ON_ERROR_STOP=1 -q -c "drop schema public cascade; create schema public;" >/dev/null || return 1
  psql -v ON_ERROR_STOP=1 -q -f "$D/01_ambiente.sql" >/dev/null || return 1
  psql -v ON_ERROR_STOP=1 -q -f "$D/00_barreira_producao.sql" >/dev/null || return 1
  psql -v ON_ERROR_STOP=1 -q -f supabase/aguardando_aprovacao/20261106120000_tabulacao_retorno_financeiro.sql.pendente >/dev/null || return 1
  psql -v ON_ERROR_STOP=1 -q -f "$MIG" >/dev/null || return 1
  psql -v ON_ERROR_STOP=1 -q -c "grant usage on schema public to app_teste; grant select on public.tabulacoes, public.alunos, public.usuarios to app_teste; grant update on public.alunos to app_teste; grant select, insert on public.aluno_movimentacoes to app_teste;" >/dev/null || return 1
  psql -v ON_ERROR_STOP=1 -q -f "$D/13p_rls_role.sql" >/dev/null || return 1
}

cenario() {  # $1 nome; $2 esperado (rc); $3 marcador exigido em stdout; $4..: variáveis de falha
  local nome="$1" esperado="$2" marcador="$3"; shift 3
  reconstroi || { echo "FALHA ($nome): reconstrução do banco"; FAIL=1; return; }
  # Referência: estado ANTES da prep do teste 15 (donos postgres). Depois, a prep (donos dono_teste) e o bloco.
  local antes depois saida rc
  antes=$(estado)
  psql -v ON_ERROR_STOP=1 -q -f "$D/15p_dono_teste.sql" >/dev/null || { echo "FALHA ($nome): prep 15p"; FAIL=1; return; }
  saida=$(env "$@" bash "$D/executa_contencao_15.sh" 2>&1); rc=$?
  depois=$(estado)
  if [ "$rc" -ne "$esperado" ]; then echo "FALHA ($nome): rc=$rc, esperado $esperado"; echo "$saida" | tail -5; FAIL=1; fi
  if ! echo "$saida" | grep -qF "$marcador"; then echo "FALHA ($nome): marcador '$marcador' ausente"; echo "$saida" | tail -5; FAIL=1; fi
  if [ "$antes" != "$depois" ]; then echo "FALHA ($nome): estado final difere do inicial"; diff <(echo "$antes") <(echo "$depois"); FAIL=1; fi
  echo "--- $nome: rc=$rc | saída relevante:"; echo "$saida" | grep -E "\[15|FALHA_INJETADA|ERRO: restauração|OK contenção" | cut -c1-160
  if [ "$FAIL" -eq 0 ]; then echo "OK ($nome): rc=$rc, estado restaurado igual ao inicial"; fi
}

cenario "controle sem falha" 0 "OK contenção 15b/15c"
cenario "falha em 15b (primeira) com 15c ainda rodando" 1 "[15c rc=0]" FALHA_15B=1
cenario "falha em 15b e 15c: código é o da primeira" 1 "[15c rc=1]" FALHA_15B=1 FALHA_15C=1
cenario "falha em 15b e falha de restauração (sinalizada)" 1 "ERRO: restauração do ambiente falhou" FALHA_15B=1 FALHA_RESTAURA=1

if [ "$FAIL" -ne 0 ]; then echo "RECUPERAÇÃO DO TRAP: FALHOU"; exit 1; fi
echo "RECUPERAÇÃO DO TRAP: OK (4 cenários em PostgreSQL real descartável)"
